/**
 * Per-language test runner — materialises an exercise's editable files
 * + the model's edits + the hidden tests onto disk, then dispatches to
 * the language toolchain (pytest / go test / cargo test / vitest / make
 * test) and turns the exit code into a pass/fail verdict.
 *
 * Sandboxing:
 *   - tmpdir per instance, deleted after execution
 *   - child process via Node's `child_process.spawn` (no shell)
 *   - per-instance timeout via AbortSignal
 *   - environment scrubbed of NEXUS_* / OPENAI_* secrets so the
 *     toolchain can't read them via env-var inspection
 *
 * What this is NOT:
 *   - A general-purpose Python / Go / Rust sandbox. The operator is
 *     trusted to run this against vetted Aider-AI/aider exercises;
 *     malicious content in the exercises would still be a problem.
 *     Issue #5 tracks moving to per-language Docker if that becomes
 *     a real concern.
 *
 * @module runner/test-runner
 */

import { spawn as nodeSpawn } from 'node:child_process';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type { AiderInstance, AiderPrediction, PolyglotLanguage } from '../types.js';

// ============================================================================
// Public API
// ============================================================================

export type SpawnImpl = (
  command: string,
  args: readonly string[],
  options: SpawnOptions
) => ChildProcess;

export interface RunTestsOptions {
  /** Hard timeout for the whole test invocation. Default: 60s. */
  readonly timeoutMs?: number;
  /**
   * Spawn injection point — only `child_process.spawn` is used by
   * default; tests inject a mock here without monkey-patching globals.
   */
  readonly spawnImpl?: SpawnImpl;
  /**
   * Workspace dir override. Default: a fresh tmpdir created and
   * deleted by the runner. Useful for debugging.
   */
  readonly workspaceDir?: string;
  /**
   * If true, do NOT delete the workspace after the run. Reserved for
   * post-mortem inspection during local-dev. Default: false.
   */
  readonly keepWorkspace?: boolean;
}

export interface TestRunResult {
  /** True iff the test command exited 0 within the timeout. */
  readonly passed: boolean;
  /** Tool that ran (e.g. `pytest`, `go test`, `cargo test`). */
  readonly testRunner: string;
  /** Truncated stderr — useful for diagnosis. ≤ 4 KB. */
  readonly stderr: string;
  /** Truncated stdout — typically the test runner's pass/fail summary. ≤ 4 KB. */
  readonly stdout: string;
  /** Exit code, or null if killed by timeout. */
  readonly exitCode: number | null;
  /** True iff timeout fired (process was killed). */
  readonly timedOut: boolean;
  /** True iff the toolchain wasn't found in PATH. */
  readonly toolchainMissing: boolean;
}

/**
 * Run the language toolchain against an exercise + the model's edits.
 *
 * Returns a `TestRunResult` describing the outcome. Never throws —
 * spawn errors come back via `toolchainMissing` / `passed: false`.
 */
export async function runTests(
  instance: AiderInstance,
  prediction: AiderPrediction,
  options: RunTestsOptions = {}
): Promise<TestRunResult> {
  const dispatch = TOOLCHAIN_BY_LANGUAGE[instance.language];
  const timeoutMs = options.timeoutMs ?? 60_000;
  const spawnImpl = options.spawnImpl ?? nodeSpawn;
  const keepWorkspace = options.keepWorkspace ?? false;

  const workspace =
    options.workspaceDir ?? mkdtempSync(join(tmpdir(), `aider-polyglot-${instance.language}-`));

  try {
    materializeWorkspace(instance, prediction, workspace);
    const result = await invokeToolchain(dispatch, workspace, timeoutMs, spawnImpl);
    return result;
  } finally {
    if (!keepWorkspace && options.workspaceDir === undefined) {
      rmSync(workspace, { recursive: true, force: true });
    }
  }
}

// ============================================================================
// Workspace materialisation
// ============================================================================

function materializeWorkspace(
  instance: AiderInstance,
  prediction: AiderPrediction,
  workspace: string
): void {
  // 1. Write the original editable files (so any not edited by the model
  //    still exist on disk in their starter form). Then overlay the
  //    model's emitted edits on top.
  const startFiles: Record<string, string> = { ...instance.editableFiles };
  for (const [path, content] of Object.entries(prediction.editedFiles)) {
    startFiles[path] = content;
  }
  writeFileTree(workspace, startFiles);

  // 2. Write hidden test files alongside.
  if (instance.hiddenTests !== undefined) {
    writeFileTree(workspace, instance.hiddenTests);
  }
}

function writeFileTree(rootDir: string, files: Readonly<Record<string, string>>): void {
  for (const [relPath, content] of Object.entries(files)) {
    if (relPath.includes('..')) {
      throw new Error(`Refusing to write file with parent-traversal path: ${relPath}`);
    }
    const fullPath = join(rootDir, relPath);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content, 'utf8');
  }
}

// ============================================================================
// Per-language dispatch
// ============================================================================

interface ToolchainSpec {
  readonly runner: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
}

const TOOLCHAIN_BY_LANGUAGE: Record<PolyglotLanguage, ToolchainSpec> = {
  python: {
    runner: 'pytest',
    command: 'pytest',
    args: ['-q', '--no-header', '-x'],
    env: {
      PYTHONDONTWRITEBYTECODE: '1',
      PYTHONUNBUFFERED: '1',
    },
  },
  javascript: {
    // npm test is the convention; most Aider polyglot JS exercises ship
    // a package.json that wires this up to vitest or jest.
    runner: 'npm test',
    command: 'npm',
    args: ['test', '--silent'],
  },
  typescript: {
    runner: 'npm test',
    command: 'npm',
    args: ['test', '--silent'],
  },
  go: {
    runner: 'go test',
    command: 'go',
    args: ['test', './...'],
  },
  rust: {
    runner: 'cargo test',
    command: 'cargo',
    // --quiet keeps the output small enough for our 4 KB cap. -- --test-threads=1
    // makes failure traces deterministic.
    args: ['test', '--quiet', '--', '--test-threads=1'],
  },
  cpp: {
    // The Aider polyglot C++ exercises use a Makefile with a `test` target.
    runner: 'make test',
    command: 'make',
    args: ['test'],
  },
};

// ============================================================================
// Toolchain invocation
// ============================================================================

async function invokeToolchain(
  spec: ToolchainSpec,
  workspace: string,
  timeoutMs: number,
  spawnImpl: SpawnImpl
): Promise<TestRunResult> {
  const env = scrubEnv({ ...process.env, ...(spec.env ?? {}) });

  return new Promise<TestRunResult>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawnImpl(spec.command, spec.args, {
        cwd: workspace,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e: unknown) {
      // Synchronous spawn errors (rare — usually only EACCES / ENOENT
      // when the binary is missing on the system).
      resolve({
        passed: false,
        testRunner: spec.runner,
        stderr: e instanceof Error ? e.message : String(e),
        stdout: '',
        exitCode: null,
        timedOut: false,
        toolchainMissing: true,
      });
      return;
    }

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer | string) => {
      if (stdout.length < OUTPUT_CAP) {
        stdout += String(chunk).slice(0, OUTPUT_CAP - stdout.length);
      }
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      if (stderr.length < OUTPUT_CAP) {
        stderr += String(chunk).slice(0, OUTPUT_CAP - stderr.length);
      }
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    timer.unref?.();

    let toolchainMissing = false;
    child.on('error', (err: NodeJS.ErrnoException) => {
      // Async spawn errors — most commonly ENOENT when the toolchain
      // isn't installed.
      if (err.code === 'ENOENT') toolchainMissing = true;
      stderr += stderr.length === 0 ? err.message : `\n${err.message}`;
    });

    child.on('close', (exitCode: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timer);
      void signal;
      const passed = exitCode === 0 && !timedOut && !toolchainMissing;
      resolve({
        passed,
        testRunner: spec.runner,
        stderr: stderr.slice(0, OUTPUT_CAP),
        stdout: stdout.slice(0, OUTPUT_CAP),
        exitCode,
        timedOut,
        toolchainMissing,
      });
    });
  });
}

const OUTPUT_CAP = 4096;

/**
 * Strip secrets from the env passed to the test toolchain. The
 * exercise code is third-party; treat it as semi-trusted.
 */
function scrubEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  const sensitivePrefixes = [
    'OPENAI_',
    'ANTHROPIC_',
    'GOOGLE_AI_',
    'OPENROUTER_',
    'NEXUS_',
    'GITHUB_TOKEN',
    'GH_TOKEN',
    'NPM_TOKEN',
    'AWS_',
  ];
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    const isSensitive = sensitivePrefixes.some((p) => k === p || k.startsWith(p));
    if (isSensitive) continue;
    out[k] = v;
  }
  return out;
}
