/**
 * Smoke tests for AiderPolyglotAdapter.
 *
 * Mocks IModelAdapter so tests don't make real model calls. Asserts the
 * BenchmarkAdapter contract end-to-end against the bundled fixture.
 */
import { EventEmitter } from 'node:events';
import { describe, it, expect, vi } from 'vitest';
import { ok, runBenchmark, type IModelAdapter } from 'nexus-agents';
import { AiderPolyglotAdapter } from './adapter.js';
import { extractEditedFiles } from './runner/file-extractor.js';
import { composeUserPrompt, getSystemPrompt } from './runner/prompt-template.js';
import type { AiderInstance } from './types.js';

const fixtureInstance: AiderInstance = {
  instanceId: 'python/return-ok',
  language: 'python',
  problemStatement: 'Make solve("foo") return "ok".',
  editableFiles: {
    'solve.py': 'def solve(x):\n    return ""\n',
  },
};

function makeMockModelAdapter(response: string): IModelAdapter {
  const completion = vi.fn(() => Promise.resolve(ok({ content: response })));
  return {
    providerId: 'mock',
    modelId: 'mock-aider-model',
    capabilities: [],
    complete: completion as never,
    stream: (() => (async function* () {})()) as never,
    countTokens: () => Promise.resolve(0),
    validateConfig: () => ({ ok: true as const, value: undefined }),
  };
}

describe('AiderPolyglotAdapter', () => {
  it('parses fenced path-tagged blocks into edited files', async () => {
    const response = '```python path=solve.py\ndef solve(x):\n    return "ok" if x else ""\n```';
    const adapter = new AiderPolyglotAdapter(makeMockModelAdapter(response));
    const prediction = await adapter.runInstance(fixtureInstance, {} as never);
    expect(prediction.editedFiles['solve.py']).toContain('return "ok" if x else ""');
  });

  it('drops hallucinated paths the instance did not declare editable', async () => {
    const response =
      '```python path=solve.py\ndef solve(x):\n    return "ok"\n```\n```python path=hallucinated.py\nprint("nope")\n```';
    const adapter = new AiderPolyglotAdapter(makeMockModelAdapter(response));
    const prediction = await adapter.runInstance(fixtureInstance, {} as never);
    expect(Object.keys(prediction.editedFiles)).toEqual(['solve.py']);
  });

  it('records empty-edit responses without throwing', async () => {
    const adapter = new AiderPolyglotAdapter(makeMockModelAdapter('I cannot solve this.'));
    const prediction = await adapter.runInstance(fixtureInstance, {} as never);
    expect(Object.keys(prediction.editedFiles)).toHaveLength(0);
    const verdict = await adapter.evaluate(fixtureInstance, prediction);
    expect(verdict.editsProduced).toBe(false);
    expect(adapter.isPass(verdict)).toBe(false);
  });

  it('isPass true when edits non-empty', async () => {
    const response = '```python path=solve.py\ndef solve(x):\n    return "ok"\n```';
    const adapter = new AiderPolyglotAdapter(makeMockModelAdapter(response));
    const prediction = await adapter.runInstance(fixtureInstance, {} as never);
    const verdict = await adapter.evaluate(fixtureInstance, prediction);
    expect(adapter.isPass(verdict)).toBe(true);
    expect(verdict.editedFileCount).toBe(1);
  });

  it('end-to-end against bundled fixture (6 languages)', async () => {
    // Mock returns a non-empty edit for whatever path the instance asked
    // about. We use a generic response that matches the fixture's known
    // single-file shape per language.
    const response = '```text path={{path}}\nedited\n```';
    const completion = vi.fn((req: { messages: { content: string }[] }) => {
      // Find the editable path from the user prompt + substitute.
      const userText = req.messages[req.messages.length - 1]?.content ?? '';
      const pathMatch = /--- ([^\s]+) ---/.exec(userText);
      const path = pathMatch?.[1] ?? 'solve.py';
      const filled = response.replace('{{path}}', path);
      return Promise.resolve(ok({ content: filled }));
    });
    const adapter = new AiderPolyglotAdapter(
      {
        providerId: 'mock',
        modelId: 'mock',
        capabilities: [],
        complete: completion as never,
        stream: (() => (async function* () {})()) as never,
        countTokens: () => Promise.resolve(0),
        validateConfig: () => ({ ok: true as const, value: undefined }),
      },
      { source: 'fixture' }
    );
    const summary = await runBenchmark(adapter, {});
    expect(summary.name).toBe('aider-polyglot');
    expect(summary.total).toBe(6);
    expect(summary.passed).toBe(6);
  });

  it('language filter narrows the fixture set', async () => {
    const adapter = new AiderPolyglotAdapter(makeMockModelAdapter(''), {
      source: 'fixture',
      languages: ['rust', 'go'],
    });
    const instances = await adapter.loadInstances({});
    expect(instances).toHaveLength(2);
    expect(instances.every((i) => i.language === 'rust' || i.language === 'go')).toBe(true);
  });

  it('summarize byLanguage breakdown drops zero-instance entries', () => {
    const adapter = new AiderPolyglotAdapter(makeMockModelAdapter(''));
    const verdicts = [
      { instanceId: 'a', language: 'python' as const, editsProduced: true, editedFileCount: 1 },
      { instanceId: 'b', language: 'go' as const, editsProduced: false, editedFileCount: 0, error: 'empty' },
    ];
    const summary = adapter.summarize(verdicts, 200);
    const meta = summary.metadata as {
      byLanguage: Record<string, { total: number; passed: number; passRate: number }>;
    };
    expect(meta.byLanguage['python']).toEqual({ total: 1, passed: 1, passRate: 1 });
    expect(meta.byLanguage['go']).toEqual({ total: 1, passed: 0, passRate: 0 });
    // Languages with 0 instances should not appear in the breakdown.
    expect(meta.byLanguage['rust']).toBeUndefined();
  });

  it('v0.2 isPass prefers testsPassed when present', () => {
    const adapter = new AiderPolyglotAdapter(makeMockModelAdapter(''));
    expect(
      adapter.isPass({
        instanceId: 'x',
        language: 'python',
        editsProduced: false, // v0.1 would say no
        editedFileCount: 0,
        testsPassed: true, // v0.2 says yes — wins
      })
    ).toBe(true);
    expect(
      adapter.isPass({
        instanceId: 'y',
        language: 'python',
        editsProduced: true, // v0.1 would say yes
        editedFileCount: 1,
        testsPassed: false, // v0.2 says no — wins
      })
    ).toBe(false);
  });

  it('v0.2 isPass falls back to v0.1 verdict when testsPassed undefined', () => {
    const adapter = new AiderPolyglotAdapter(makeMockModelAdapter(''));
    expect(
      adapter.isPass({
        instanceId: 'z',
        language: 'python',
        editsProduced: true,
        editedFileCount: 1,
      })
    ).toBe(true);
  });

  it('v0.2 evaluate runs tests when hiddenTests present + runTests on', async () => {
    const editsResponse =
      '```python path=solve.py\ndef solve(x): return "ok"\n```';
    const adapter = new AiderPolyglotAdapter(makeMockModelAdapter(editsResponse));

    // Mock spawn matching test-runner.test.ts's pattern.
    adapter.setSpawnImplForTests(((): unknown => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        kill: (sig: string) => boolean;
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => true;
      queueMicrotask(() => child.emit('close', 0, null));
      return child;
    }) as never);

    const instance: AiderInstance = {
      instanceId: 'python/foo',
      language: 'python',
      problemStatement: 'Q',
      editableFiles: { 'solve.py': 'def solve(x): pass\n' },
      hiddenTests: { 'test_solve.py': 'def test_x(): assert solve("x") == "ok"\n' },
    };
    const prediction = await adapter.runInstance(instance, {} as never);
    const verdict = await adapter.evaluate(instance, prediction);
    expect(verdict.testsPassed).toBe(true);
    expect(verdict.testRunner).toBe('pytest');
  });

  it('v0.2 evaluate skips tests when runTests is false', async () => {
    const editsResponse =
      '```python path=solve.py\ndef solve(x): return "ok"\n```';
    const adapter = new AiderPolyglotAdapter(makeMockModelAdapter(editsResponse), {
      runTests: false,
    });
    const instance: AiderInstance = {
      instanceId: 'python/skiptests',
      language: 'python',
      problemStatement: 'Q',
      editableFiles: { 'solve.py': 'def solve(x): pass\n' },
      hiddenTests: { 'test_solve.py': 'TESTS\n' },
    };
    const prediction = await adapter.runInstance(instance, {} as never);
    const verdict = await adapter.evaluate(instance, prediction);
    expect(verdict.testsPassed).toBeUndefined();
    expect(verdict.editsProduced).toBe(true);
  });
});

describe('extractEditedFiles', () => {
  it('parses one fenced block per file', () => {
    const response = '```py path=a.py\nA\n```\n```py path=b.py\nB\n```';
    const out = extractEditedFiles(response);
    expect(out['a.py']).toBe('A');
    expect(out['b.py']).toBe('B');
  });

  it('returns empty object for no-edits responses', () => {
    expect(extractEditedFiles('I cannot solve this.')).toEqual({});
  });

  it('handles multi-line file content', () => {
    const response = '```py path=solve.py\ndef solve(x):\n    return "ok"\n```';
    expect(extractEditedFiles(response)['solve.py']).toBe('def solve(x):\n    return "ok"');
  });
});

describe('prompt template', () => {
  it('system prompt names the fenced path= format', () => {
    expect(getSystemPrompt()).toContain('path=');
    expect(getSystemPrompt()).toContain('fenced');
  });

  it('user prompt includes problem + each editable file', () => {
    const prompt = composeUserPrompt({
      ...fixtureInstance,
      editableFiles: { 'a.py': 'AAA', 'b.py': 'BBB' },
    });
    expect(prompt).toContain('a.py');
    expect(prompt).toContain('AAA');
    expect(prompt).toContain('b.py');
    expect(prompt).toContain('BBB');
  });

  it('includes context files separately when present', () => {
    const prompt = composeUserPrompt({
      ...fixtureInstance,
      contextFiles: { 'helpers.py': 'HELP' },
    });
    expect(prompt).toContain('Read-only context');
    expect(prompt).toContain('HELP');
  });
});
