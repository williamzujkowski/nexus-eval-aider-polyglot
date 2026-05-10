/**
 * Agentic-flow runner for Aider polyglot exercises (v0.3).
 *
 * Drives an `IAgenticAdapter` from `nexus-agents` with three tools
 * scoped to a per-instance tmpdir workspace:
 *
 *   - `read_file(path)` — read any file in the workspace
 *   - `write_file(path, contents)` — write/overwrite a file (refused for paths
 *     not in the instance's `editableFiles`)
 *   - `run_tests()` — run the language toolchain (pytest / go test / etc),
 *     returning pass/fail + truncated stderr
 *
 * The agent loop iterates: model edits → harness runs tests → model
 * sees failures → re-edits → ... until pass or turn budget. Stops on
 * any tool error or AbortSignal.
 *
 * Workspace lifecycle:
 *   1. mkdtemp; materialise instance.editableFiles + instance.hiddenTests
 *   2. runAgent with the three tools above
 *   3. capture final state (model edits + final test verdict)
 *   4. rmrf workspace (caller can opt out via `keepWorkspace`)
 *
 * @module runner/agentic-flow
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, normalize, relative } from 'node:path';

import {
  createAgenticAdapter,
  type AgentRunResult,
  type IModelAdapter,
  type AgenticToolCall as ToolCall,
  type AgenticToolResult as ToolResult,
} from 'nexus-agents';

import { runTests, type TestRunResult, type SpawnImpl } from './test-runner.js';
import type { AiderInstance, AiderPrediction } from '../types.js';

/**
 * One v0.3 agentic-flow result. Combines what the model emitted (edits)
 * with the final test verdict + the agent run trace.
 */
export interface AgenticFlowResult {
  readonly prediction: AiderPrediction;
  readonly testResult: TestRunResult | null;
  readonly agentRun: AgentRunResult;
  readonly editedFiles: Readonly<Record<string, string>>;
}

export interface RunAgenticFlowOptions {
  /** Hard cap on agent turns. Defaults to the resolved profile's recommendation. */
  readonly turnBudget?: number;
  /** Hard cap on the per-test-run timeout (default 60s, same as v0.2). */
  readonly testTimeoutMs?: number;
  /** Spawn injection point — only used by tests for the test runner. */
  readonly spawnImpl?: SpawnImpl;
  /** Workspace dir override. Default: a fresh tmpdir created + deleted. */
  readonly workspaceDir?: string;
  /** Keep the workspace after the run. Default: false. */
  readonly keepWorkspace?: boolean;
  /** External cancellation. */
  readonly signal?: AbortSignal;
  /** Operator hints passed through to AgenticAdapter (gateway scenarios). */
  readonly modelHints?: Parameters<typeof createAgenticAdapter>[1] extends infer Opts
    ? Opts extends { modelHints?: infer H }
      ? H
      : never
    : never;
}

const SYSTEM_PROMPT = `You are an expert software engineer working in a sandboxed workspace.

You have three tools:
  - read_file(path): read any file in the workspace
  - write_file(path, contents): overwrite an editable file
  - run_tests(): run the test suite; returns pass/fail + stderr

Your job: edit the editable files so all tests pass.

Strategy:
  1. Read the problem statement (you'll see it in the user message).
  2. Read each editable file to understand the starting point.
  3. Make your changes via write_file.
  4. Run the tests. If they fail, study stderr and try again.
  5. When all tests pass, stop emitting tool calls — just say "done" or summarise.

Rules:
  - Only write paths the user message lists as editable. write_file refuses other paths.
  - Don't edit test files even if you can read them (the test runner will use the originals).
  - Prefer minimal changes that make tests pass.
  - Do not invent tools beyond the three above.
`;

const TOOLS = [
  {
    name: 'read_file',
    description: 'Read a file from the workspace. Returns the file contents as a string.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path relative to the workspace root.',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description:
      'Write contents to a file in the workspace. Only paths in the editable file set are allowed.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path relative to the workspace root. Must be in editableFiles.',
        },
        contents: { type: 'string', description: 'Full file contents.' },
      },
      required: ['path', 'contents'],
    },
  },
  {
    name: 'run_tests',
    description:
      'Run the language toolchain against the current workspace state. Returns pass/fail + truncated stderr.',
    inputSchema: { type: 'object' },
  },
];

/**
 * Run the agent loop for one Aider polyglot instance. The harness owns
 * the tools (tmpdir, file IO, test runner); the adapter drives model
 * orchestration.
 */
export async function runAgenticFlow(
  instance: AiderInstance,
  modelAdapter: IModelAdapter,
  options: RunAgenticFlowOptions = {}
): Promise<AgenticFlowResult> {
  const workspace =
    options.workspaceDir ?? mkdtempSync(join(tmpdir(), `aider-polyglot-agent-${instance.language}-`));

  try {
    materializeWorkspace(instance, workspace);

    const editablePaths = new Set(Object.keys(instance.editableFiles));
    const startedAt = Date.now();
    let lastTestResult: TestRunResult | null = null;
    const editedFiles: Record<string, string> = { ...instance.editableFiles };

    const agentic = createAgenticAdapter(modelAdapter, {
      ...(options.modelHints !== undefined && { modelHints: options.modelHints }),
    });

    const userPrompt = composeAgentPrompt(instance);
    const onToolCall = (call: ToolCall): Promise<ToolResult> =>
      handleToolCall(call, {
        workspace,
        editablePaths,
        editedFiles,
        instance,
        options,
        onTestResult: (r) => {
          lastTestResult = r;
        },
      });

    const result = await agentic.runAgent({
      systemPrompt: SYSTEM_PROMPT,
      userPrompt,
      tools: TOOLS,
      ...(options.turnBudget !== undefined && { turnBudget: options.turnBudget }),
      onToolCall,
      ...(options.signal !== undefined && { signal: options.signal }),
    });

    if (!result.ok) {
      throw new Error(`AgenticAdapter failed: ${result.error.message}`);
    }
    const agentRun = result.value;

    const prediction: AiderPrediction = {
      instanceId: instance.instanceId,
      editedFiles,
      modelLabel: modelAdapter.modelId,
      durationMs: Date.now() - startedAt,
    };

    return {
      prediction,
      testResult: lastTestResult,
      agentRun,
      editedFiles,
    };
  } finally {
    if (options.keepWorkspace !== true && options.workspaceDir === undefined) {
      rmSync(workspace, { recursive: true, force: true });
    }
  }
}

function materializeWorkspace(instance: AiderInstance, workspace: string): void {
  for (const [path, content] of Object.entries(instance.editableFiles)) {
    writeFileSafely(workspace, path, content);
  }
  if (instance.hiddenTests !== undefined) {
    for (const [path, content] of Object.entries(instance.hiddenTests)) {
      writeFileSafely(workspace, path, content);
    }
  }
}

function writeFileSafely(workspace: string, relPath: string, content: string): void {
  const safe = ensureInsideWorkspace(workspace, relPath);
  mkdirSync(dirname(safe), { recursive: true });
  writeFileSync(safe, content, 'utf8');
}

/**
 * Refuse path traversal. Throws if the resolved absolute path of
 * `relPath` escapes the workspace dir.
 */
function ensureInsideWorkspace(workspace: string, relPath: string): string {
  const abs = normalize(join(workspace, relPath));
  const rel = relative(workspace, abs);
  if (rel.startsWith('..') || rel === '..') {
    throw new Error(`Refusing parent-traversal path: ${relPath}`);
  }
  return abs;
}

function composeAgentPrompt(instance: AiderInstance): string {
  const lines: string[] = [
    `Exercise: ${instance.instanceId}`,
    `Language: ${instance.language}`,
    '',
    'Problem statement:',
    instance.problemStatement,
    '',
    'Editable files (the only paths write_file will accept):',
    ...Object.keys(instance.editableFiles).map((p) => `  - ${p}`),
    '',
    'Use the tools to read, edit, and test until the suite passes.',
  ];
  return lines.join('\n');
}

interface ToolContext {
  readonly workspace: string;
  readonly editablePaths: ReadonlySet<string>;
  readonly editedFiles: Record<string, string>;
  readonly instance: AiderInstance;
  readonly options: RunAgenticFlowOptions;
  readonly onTestResult: (r: TestRunResult) => void;
}

async function handleToolCall(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
  switch (call.name) {
    case 'read_file':
      return handleReadFile(call.arguments, ctx);
    case 'write_file':
      return handleWriteFile(call.arguments, ctx);
    case 'run_tests':
      return handleRunTests(ctx);
    default:
      return {
        content: `Unknown tool: ${call.name}. Use read_file, write_file, or run_tests.`,
        isError: true,
      };
  }
}

function handleReadFile(args: Record<string, unknown>, ctx: ToolContext): ToolResult {
  const path = typeof args['path'] === 'string' ? args['path'] : '';
  if (path === '') return { content: 'read_file: missing `path` argument', isError: true };
  try {
    const abs = ensureInsideWorkspace(ctx.workspace, path);
    return { content: readFileSync(abs, 'utf8') };
  } catch (e: unknown) {
    return {
      content: `read_file failed: ${e instanceof Error ? e.message : String(e)}`,
      isError: true,
    };
  }
}

function handleWriteFile(args: Record<string, unknown>, ctx: ToolContext): ToolResult {
  const path = typeof args['path'] === 'string' ? args['path'] : '';
  const contents = typeof args['contents'] === 'string' ? args['contents'] : '';
  if (path === '') return { content: 'write_file: missing `path` argument', isError: true };
  if (!ctx.editablePaths.has(path)) {
    return {
      content: `write_file: path '${path}' is not editable. Editable paths: ${[...ctx.editablePaths].join(', ')}`,
      isError: true,
    };
  }
  try {
    writeFileSafely(ctx.workspace, path, contents);
    ctx.editedFiles[path] = contents;
    return { content: `wrote ${String(contents.length)} bytes to ${path}` };
  } catch (e: unknown) {
    return {
      content: `write_file failed: ${e instanceof Error ? e.message : String(e)}`,
      isError: true,
    };
  }
}

async function handleRunTests(ctx: ToolContext): Promise<ToolResult> {
  // Re-run with current editedFiles state. Use the same test-runner as
  // v0.2 — feed it a synthetic prediction with the current edits.
  const synthetic: AiderPrediction = {
    instanceId: ctx.instance.instanceId,
    editedFiles: ctx.editedFiles,
    modelLabel: 'agentic',
    durationMs: 0,
  };
  const result = await runTests(ctx.instance, synthetic, {
    ...(ctx.options.testTimeoutMs !== undefined && { timeoutMs: ctx.options.testTimeoutMs }),
    ...(ctx.options.spawnImpl !== undefined && { spawnImpl: ctx.options.spawnImpl }),
    workspaceDir: ctx.workspace,
    keepWorkspace: true,
  });
  ctx.onTestResult(result);
  if (result.passed) {
    return { content: `Tests passed (${result.testRunner}). Stop emitting tool calls.` };
  }
  return {
    content:
      `Tests failed (${result.testRunner}, exit ${String(result.exitCode)}, timedOut=${String(result.timedOut)}).\n\n` +
      `STDERR:\n${result.stderr || '(empty)'}\n\nSTDOUT:\n${result.stdout || '(empty)'}`,
    isError: !result.passed,
  };
}
