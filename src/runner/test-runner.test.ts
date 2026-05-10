/**
 * Tests for the per-language test runner. Mocks `child_process.spawn`
 * via the spawnImpl injection point — no real pytest / cargo / etc.
 * actually runs in CI.
 *
 * Real-toolchain integration is tested locally and is out of scope for
 * unit tests (CI runners may not have all 6 language toolchains
 * installed).
 */
import { EventEmitter } from 'node:events';
import { describe, it, expect, vi } from 'vitest';

import { runTests, type SpawnImpl } from './test-runner.js';
import type { AiderInstance, AiderPrediction } from '../types.js';

interface MockChildOptions {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  delayMs?: number;
  errorCode?: string;
}

function makeMockChild(opts: MockChildOptions = {}) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: (signal: string) => boolean;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn(() => true);

  const fire = (): void => {
    if (opts.stdout !== undefined) child.stdout.emit('data', opts.stdout);
    if (opts.stderr !== undefined) child.stderr.emit('data', opts.stderr);
    if (opts.errorCode !== undefined) {
      const err = new Error('spawn failed') as NodeJS.ErrnoException;
      err.code = opts.errorCode;
      child.emit('error', err);
    }
    child.emit('close', opts.exitCode ?? 0, null);
  };
  if (opts.delayMs !== undefined) setTimeout(fire, opts.delayMs);
  else queueMicrotask(fire);

  return child;
}

function makeSpawnImpl(opts: MockChildOptions = {}): SpawnImpl {
  return vi.fn(() => makeMockChild(opts) as unknown as ReturnType<SpawnImpl>);
}

const pythonInstance: AiderInstance = {
  instanceId: 'python/foo',
  language: 'python',
  problemStatement: 'Q',
  editableFiles: { 'solve.py': 'def solve(): pass\n' },
  hiddenTests: { 'test_solve.py': 'from solve import solve\ndef test_x(): assert solve() is None\n' },
};

const goInstance: AiderInstance = {
  instanceId: 'go/sum',
  language: 'go',
  problemStatement: 'Q',
  editableFiles: { 'sum.go': 'package sum\n' },
  hiddenTests: { 'sum_test.go': 'package sum\n' },
};

const prediction: AiderPrediction = {
  instanceId: 'python/foo',
  editedFiles: { 'solve.py': 'def solve(): return "ok"\n' },
  modelLabel: 'mock',
  durationMs: 10,
};

describe('runTests', () => {
  it('reports pass when the toolchain exits 0', async () => {
    const spawnImpl = makeSpawnImpl({ exitCode: 0, stdout: '1 passed\n' });
    const result = await runTests(pythonInstance, prediction, { spawnImpl });
    expect(result.passed).toBe(true);
    expect(result.testRunner).toBe('pytest');
    expect(result.stdout).toContain('1 passed');
    expect(result.exitCode).toBe(0);
  });

  it('reports fail when the toolchain exits non-zero', async () => {
    const spawnImpl = makeSpawnImpl({
      exitCode: 1,
      stderr: 'AssertionError: expected ok',
    });
    const result = await runTests(pythonInstance, prediction, { spawnImpl });
    expect(result.passed).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('AssertionError');
  });

  it('reports toolchainMissing on ENOENT', async () => {
    const spawnImpl = makeSpawnImpl({ errorCode: 'ENOENT', exitCode: null });
    const result = await runTests(pythonInstance, prediction, { spawnImpl });
    expect(result.toolchainMissing).toBe(true);
    expect(result.passed).toBe(false);
  });

  it('dispatches to per-language toolchain (go test for Go instances)', async () => {
    let capturedCommand: string | undefined;
    let capturedArgs: readonly string[] | undefined;
    const spawnImpl: SpawnImpl = vi.fn((command, args) => {
      capturedCommand = command;
      capturedArgs = args;
      return makeMockChild({ exitCode: 0 }) as unknown as ReturnType<SpawnImpl>;
    });
    await runTests(goInstance, prediction, { spawnImpl });
    expect(capturedCommand).toBe('go');
    expect(capturedArgs).toEqual(['test', './...']);
  });

  it('passes a per-language env with PYTHONDONTWRITEBYTECODE for Python', async () => {
    let capturedEnv: NodeJS.ProcessEnv | undefined;
    const spawnImpl: SpawnImpl = vi.fn((_cmd, _args, options) => {
      capturedEnv = options.env as NodeJS.ProcessEnv | undefined;
      return makeMockChild({ exitCode: 0 }) as unknown as ReturnType<SpawnImpl>;
    });
    await runTests(pythonInstance, prediction, { spawnImpl });
    expect(capturedEnv?.['PYTHONDONTWRITEBYTECODE']).toBe('1');
    expect(capturedEnv?.['PYTHONUNBUFFERED']).toBe('1');
  });

  it('scrubs sensitive env vars (OPENAI_*, NEXUS_*, GITHUB_TOKEN)', async () => {
    const before = {
      OPENAI_API_KEY: process.env['OPENAI_API_KEY'],
      NEXUS_LOG_LEVEL: process.env['NEXUS_LOG_LEVEL'],
      GITHUB_TOKEN: process.env['GITHUB_TOKEN'],
    };
    process.env['OPENAI_API_KEY'] = 'sk-secret';
    process.env['NEXUS_LOG_LEVEL'] = 'debug';
    process.env['GITHUB_TOKEN'] = 'gh-secret';
    try {
      let capturedEnv: NodeJS.ProcessEnv | undefined;
      const spawnImpl: SpawnImpl = vi.fn((_cmd, _args, options) => {
        capturedEnv = options.env as NodeJS.ProcessEnv | undefined;
        return makeMockChild({ exitCode: 0 }) as unknown as ReturnType<SpawnImpl>;
      });
      await runTests(pythonInstance, prediction, { spawnImpl });
      expect(capturedEnv?.['OPENAI_API_KEY']).toBeUndefined();
      expect(capturedEnv?.['NEXUS_LOG_LEVEL']).toBeUndefined();
      expect(capturedEnv?.['GITHUB_TOKEN']).toBeUndefined();
    } finally {
      // Restore env so other tests don't see the spoofed values.
      for (const [k, v] of Object.entries(before)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it('caps stdout + stderr at 4 KB', async () => {
    const huge = 'x'.repeat(100_000);
    const spawnImpl = makeSpawnImpl({ exitCode: 0, stdout: huge, stderr: huge });
    const result = await runTests(pythonInstance, prediction, { spawnImpl });
    expect(result.stdout.length).toBeLessThanOrEqual(4096);
    expect(result.stderr.length).toBeLessThanOrEqual(4096);
  });

  it('reports timedOut when the toolchain exceeds the timeout', async () => {
    const spawnImpl = makeSpawnImpl({ exitCode: null, delayMs: 200 });
    const result = await runTests(pythonInstance, prediction, {
      spawnImpl,
      timeoutMs: 50,
    });
    expect(result.timedOut).toBe(true);
    expect(result.passed).toBe(false);
  });

  it('refuses to materialise paths with parent-directory traversal', async () => {
    const evilInstance: AiderInstance = {
      ...pythonInstance,
      hiddenTests: { '../escape.py': 'evil' },
    };
    const spawnImpl = makeSpawnImpl({ exitCode: 0 });
    await expect(runTests(evilInstance, prediction, { spawnImpl })).rejects.toThrow(
      /parent-traversal/
    );
  });

  it('falls back to v0.1 verdict (skips tests) when hiddenTests is missing', async () => {
    // The runner is still invoked; absent hiddenTests means only the
    // editable files get materialised (no tests written) — but the
    // toolchain will still run. The adapter is what gates this; this
    // test just confirms the runner doesn't crash on an instance with
    // no hiddenTests.
    const noTestsInstance: AiderInstance = {
      ...pythonInstance,
    };
    delete (noTestsInstance as { hiddenTests?: unknown }).hiddenTests;
    const spawnImpl = makeSpawnImpl({ exitCode: 0 });
    const result = await runTests(noTestsInstance, prediction, { spawnImpl });
    expect(result.passed).toBe(true);
  });
});
