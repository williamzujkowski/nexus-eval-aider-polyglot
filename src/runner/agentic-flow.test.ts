/**
 * Tests for the v0.3 agentic-flow runner. Mocks IModelAdapter so we
 * can drive the agent loop deterministically + mocks spawn for the
 * test runner so no real toolchains run in CI.
 */
import { EventEmitter } from 'node:events';
import { describe, it, expect, vi } from 'vitest';
import { ok, type IModelAdapter, type ContentBlock } from 'nexus-agents';

import { runAgenticFlow } from './agentic-flow.js';
import type { SpawnImpl } from './test-runner.js';
import type { AiderInstance } from '../types.js';

const fixtureInstance: AiderInstance = {
  instanceId: 'python/return-ok',
  language: 'python',
  problemStatement: 'Make solve(x) return "ok".',
  editableFiles: { 'solve.py': 'def solve(x):\n    return ""\n' },
  hiddenTests: { 'test_solve.py': 'from solve import solve\ndef test_x(): assert solve("y") == "ok"\n' },
};

interface ScriptedTurn {
  readonly toolCalls: readonly { id: string; name: string; input: Record<string, unknown> }[];
  readonly stop?: 'end_turn' | 'tool_use';
}

function makeScriptedModel(turns: readonly ScriptedTurn[]): IModelAdapter {
  let i = 0;
  const complete = vi.fn(() => {
    const turn = turns[i] ?? turns[turns.length - 1];
    i += 1;
    if (turn === undefined || turn.toolCalls.length === 0) {
      return Promise.resolve(
        ok({
          content: [{ type: 'text', text: 'done' }] as ContentBlock[],
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          stopReason: 'end_turn' as const,
          model: 'mock',
        })
      );
    }
    return Promise.resolve(
      ok({
        content: turn.toolCalls.map((t) => ({
          type: 'tool_use' as const,
          id: t.id,
          name: t.name,
          input: t.input,
        })) as ContentBlock[],
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        stopReason: turn.stop ?? ('tool_use' as const),
        model: 'mock',
      })
    );
  });
  return {
    providerId: 'anthropic',
    modelId: 'claude-mock',
    capabilities: [],
    complete: complete as never,
    stream: (() => (async function* () {})()) as never,
    countTokens: () => Promise.resolve(0),
    validateConfig: () => ({ ok: true as const, value: undefined }),
  };
}

function makeMockSpawn(opts: { exitCode: number; stdout?: string; stderr?: string }): SpawnImpl {
  return vi.fn(() => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: () => boolean;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => true;
    queueMicrotask(() => {
      if (opts.stdout !== undefined) child.stdout.emit('data', opts.stdout);
      if (opts.stderr !== undefined) child.stderr.emit('data', opts.stderr);
      child.emit('close', opts.exitCode, null);
    });
    return child as never;
  });
}

describe('runAgenticFlow', () => {
  it('handles read_file → returns the editable file contents', async () => {
    const model = makeScriptedModel([
      {
        toolCalls: [{ id: 't1', name: 'read_file', input: { path: 'solve.py' } }],
      },
      { toolCalls: [], stop: 'end_turn' },
    ]);
    const result = await runAgenticFlow(fixtureInstance, model, { turnBudget: 5 });
    expect(result.agentRun.stopReason).toBe('agent-stopped');
    expect(result.agentRun.turns[0]?.toolResult.content).toContain('def solve(x):');
  });

  it('handles write_file → updates editedFiles', async () => {
    const newContent = 'def solve(x): return "ok"\n';
    const model = makeScriptedModel([
      {
        toolCalls: [
          {
            id: 't1',
            name: 'write_file',
            input: { path: 'solve.py', contents: newContent },
          },
        ],
      },
      { toolCalls: [], stop: 'end_turn' },
    ]);
    const result = await runAgenticFlow(fixtureInstance, model, { turnBudget: 5 });
    expect(result.editedFiles['solve.py']).toBe(newContent);
    expect(result.agentRun.turns[0]?.toolResult.content).toContain('wrote');
  });

  it('refuses write_file for paths not in editableFiles', async () => {
    const model = makeScriptedModel([
      {
        toolCalls: [
          {
            id: 't1',
            name: 'write_file',
            input: { path: 'test_solve.py', contents: 'evil' },
          },
        ],
      },
      { toolCalls: [], stop: 'end_turn' },
    ]);
    const result = await runAgenticFlow(fixtureInstance, model, { turnBudget: 5 });
    expect(result.agentRun.turns[0]?.toolResult.isError).toBe(true);
    expect(result.agentRun.turns[0]?.toolResult.content).toContain('not editable');
  });

  it('handles run_tests → reports pass/fail to the model', async () => {
    const spawnImpl = makeMockSpawn({ exitCode: 0, stdout: '1 passed' });
    const model = makeScriptedModel([
      { toolCalls: [{ id: 't1', name: 'run_tests', input: {} }] },
      { toolCalls: [], stop: 'end_turn' },
    ]);
    const result = await runAgenticFlow(fixtureInstance, model, { turnBudget: 5, spawnImpl });
    expect(result.testResult?.passed).toBe(true);
    expect(result.agentRun.turns[0]?.toolResult.content).toContain('Tests passed');
  });

  it('iterate-on-failure: write → test (fail) → re-write → test (pass)', async () => {
    let testCallCount = 0;
    const spawnImpl: SpawnImpl = vi.fn(() => {
      testCallCount += 1;
      const passing = testCallCount >= 2;
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        kill: () => boolean;
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => true;
      queueMicrotask(() => {
        if (!passing) child.stderr.emit('data', 'AssertionError');
        child.emit('close', passing ? 0 : 1, null);
      });
      return child as never;
    });
    const model = makeScriptedModel([
      {
        toolCalls: [
          {
            id: 't1',
            name: 'write_file',
            input: { path: 'solve.py', contents: 'wrong' },
          },
        ],
      },
      { toolCalls: [{ id: 't2', name: 'run_tests', input: {} }] },
      {
        toolCalls: [
          {
            id: 't3',
            name: 'write_file',
            input: { path: 'solve.py', contents: 'right' },
          },
        ],
      },
      { toolCalls: [{ id: 't4', name: 'run_tests', input: {} }] },
      { toolCalls: [], stop: 'end_turn' },
    ]);
    const result = await runAgenticFlow(fixtureInstance, model, { turnBudget: 10, spawnImpl });
    expect(result.testResult?.passed).toBe(true);
    expect(result.agentRun.turnsUsed).toBe(4);
    expect(result.editedFiles['solve.py']).toBe('right');
  });

  it('refuses unknown tool name with isError', async () => {
    const model = makeScriptedModel([
      {
        toolCalls: [{ id: 't1', name: 'wave_magic_wand', input: {} }],
      },
      { toolCalls: [], stop: 'end_turn' },
    ]);
    const result = await runAgenticFlow(fixtureInstance, model, { turnBudget: 3 });
    expect(result.agentRun.turns[0]?.toolResult.isError).toBe(true);
    expect(result.agentRun.turns[0]?.toolResult.content).toContain('Unknown tool');
  });

  it('uses model profile turnBudget by default', async () => {
    // claude-mock resolves to no specific family; falls back to anthropic-default = 15.
    const model = makeScriptedModel([
      // Endless tool_use to hit the budget
      { toolCalls: [{ id: 'x', name: 'read_file', input: { path: 'solve.py' } }] },
    ]);
    const result = await runAgenticFlow(fixtureInstance, model);
    expect(result.agentRun.stopReason).toBe('turn-budget');
    // anthropic-default budget is 15
    expect(result.agentRun.turnsUsed).toBe(15);
  });

  it('AbortSignal pre-set: aborted before first turn → cancelled immediately', async () => {
    const ac = new AbortController();
    ac.abort();
    const model = makeScriptedModel([
      { toolCalls: [{ id: 't1', name: 'read_file', input: { path: 'solve.py' } }] },
    ]);
    const result = await runAgenticFlow(fixtureInstance, model, {
      turnBudget: 5,
      signal: ac.signal,
    });
    expect(result.agentRun.stopReason).toBe('cancelled');
    expect(result.agentRun.turnsUsed).toBe(0);
  });
});
