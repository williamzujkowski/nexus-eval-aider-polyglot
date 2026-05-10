/**
 * Tests for the GitHub-fetch loader.
 *
 * Mocks `fetch` directly via the `fetchImpl` injection point — no
 * monkey-patching globals, no MSW. Tests cover:
 *   - Trees API + raw file fetching shape
 *   - Test-file filtering at fetch time
 *   - Skip-dir exclusions
 *   - Per-language cache (second call doesn't re-hit the network)
 *   - GITHUB_TOKEN auth header when env is set
 *   - Truncated tree warning
 *   - Error path: non-2xx response surfaces a usable message
 */
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { loadFromGithub } from './github-loader.js';

interface TreeEntry {
  path: string;
  type: 'blob' | 'tree';
  sha: string;
}

function makeTreeResponse(entries: TreeEntry[], truncated = false): Response {
  return new Response(JSON.stringify({ tree: entries, truncated }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function makeRawResponse(body: string): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'text/plain' } });
}

function makeFetchMock(plan: Record<string, Response | (() => Response)>): typeof fetch {
  return vi.fn(async (url: string | URL | Request) => {
    const u = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
    for (const [pattern, response] of Object.entries(plan)) {
      if (u.includes(pattern)) {
        return typeof response === 'function' ? response() : response;
      }
    }
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
}

describe('loadFromGithub', () => {
  let cacheDir: string;
  beforeEach(() => {
    cacheDir = mkdtempSync(join(tmpdir(), 'aider-polyglot-test-'));
    delete process.env['GITHUB_TOKEN'];
  });
  afterEach(() => {
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it('walks Trees API + fetches each editable file via raw URL', async () => {
    const fetchMock = makeFetchMock({
      'api.github.com': makeTreeResponse([
        {
          path: 'benchmark/exercises/python/exercises/two-sum/instructions.md',
          type: 'blob',
          sha: 'a',
        },
        {
          path: 'benchmark/exercises/python/exercises/two-sum/solution.py',
          type: 'blob',
          sha: 'b',
        },
      ]),
      'instructions.md': makeRawResponse('Write a function...'),
      'solution.py': makeRawResponse('def solve():\n    pass\n'),
    });

    const instances = await loadFromGithub({
      cacheDir,
      languages: ['python'],
      fetchImpl: fetchMock,
    });

    expect(instances).toHaveLength(1);
    expect(instances[0]?.instanceId).toBe('python/two-sum');
    expect(instances[0]?.problemStatement).toBe('Write a function...');
    expect(instances[0]?.editableFiles['solution.py']).toContain('def solve()');
  });

  it('routes test files to hiddenTests, source to editableFiles', async () => {
    const fetchMock = makeFetchMock({
      'api.github.com': makeTreeResponse([
        {
          path: 'benchmark/exercises/python/exercises/foo/instructions.md',
          type: 'blob',
          sha: 'a',
        },
        {
          path: 'benchmark/exercises/python/exercises/foo/solution.py',
          type: 'blob',
          sha: 'b',
        },
        {
          path: 'benchmark/exercises/python/exercises/foo/test_foo.py',
          type: 'blob',
          sha: 'c',
        },
        {
          path: 'benchmark/exercises/python/exercises/foo/foo_test.py',
          type: 'blob',
          sha: 'd',
        },
      ]),
      'instructions.md': makeRawResponse('Q'),
      'solution.py': makeRawResponse('S'),
      'test_foo.py': makeRawResponse('T1'),
      'foo_test.py': makeRawResponse('T2'),
    });
    const instances = await loadFromGithub({
      cacheDir,
      languages: ['python'],
      fetchImpl: fetchMock,
    });
    expect(Object.keys(instances[0]?.editableFiles ?? {})).toEqual(['solution.py']);
    expect(Object.keys(instances[0]?.hiddenTests ?? {}).sort()).toEqual([
      'foo_test.py',
      'test_foo.py',
    ]);
  });

  it('caches the per-language index — second call does not refetch', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const u = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
      if (u.includes('api.github.com')) {
        return makeTreeResponse([
          {
            path: 'benchmark/exercises/python/exercises/x/instructions.md',
            type: 'blob',
            sha: 'a',
          },
          {
            path: 'benchmark/exercises/python/exercises/x/sol.py',
            type: 'blob',
            sha: 'b',
          },
        ]);
      }
      if (u.endsWith('/instructions.md')) return makeRawResponse('Q');
      if (u.endsWith('/sol.py')) return makeRawResponse('S');
      return new Response('miss', { status: 404 });
    }) as unknown as typeof fetch;

    await loadFromGithub({ cacheDir, languages: ['python'], fetchImpl: fetchMock });
    const firstCallCount = (fetchMock as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
    expect(firstCallCount).toBeGreaterThan(0);

    await loadFromGithub({ cacheDir, languages: ['python'], fetchImpl: fetchMock });
    const secondCallCount = (fetchMock as unknown as { mock: { calls: unknown[] } }).mock.calls.length;

    // Second call hits the cache file, no additional fetches.
    expect(secondCallCount).toBe(firstCallCount);
  });

  it('attaches GITHUB_TOKEN auth header when env is set', async () => {
    process.env['GITHUB_TOKEN'] = 'sekret';
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
      if (u.includes('api.github.com')) {
        const headers = init?.headers as Record<string, string> | undefined;
        expect(headers?.['authorization']).toBe('Bearer sekret');
        return makeTreeResponse([]);
      }
      return new Response('', { status: 404 });
    }) as unknown as typeof fetch;

    await loadFromGithub({ cacheDir, languages: ['python'], fetchImpl: fetchMock });
  });

  it('surfaces a clear error on non-2xx Trees response', async () => {
    const fetchMock = makeFetchMock({
      'api.github.com': new Response('rate limit exceeded', {
        status: 403,
        statusText: 'Forbidden',
      }),
    });
    await expect(
      loadFromGithub({ cacheDir, languages: ['python'], fetchImpl: fetchMock })
    ).rejects.toThrow(/GitHub Trees API failed: 403.*GITHUB_TOKEN/s);
  });

  it('skips SKIP_DIR_PATTERNS entirely + routes tests/ to hiddenTests', async () => {
    const fetchMock = makeFetchMock({
      'api.github.com': makeTreeResponse([
        {
          path: 'benchmark/exercises/rust/exercises/y/instructions.md',
          type: 'blob',
          sha: 'a',
        },
        {
          path: 'benchmark/exercises/rust/exercises/y/src/lib.rs',
          type: 'blob',
          sha: 'b',
        },
        {
          path: 'benchmark/exercises/rust/exercises/y/target/release/foo',
          type: 'blob',
          sha: 'c',
        },
        {
          path: 'benchmark/exercises/rust/exercises/y/tests/it.rs',
          type: 'blob',
          sha: 'd',
        },
      ]),
      'instructions.md': makeRawResponse('Q'),
      'lib.rs': makeRawResponse('R'),
      'tests/it.rs': makeRawResponse('IT'),
    });
    const instances = await loadFromGithub({
      cacheDir,
      languages: ['rust'],
      fetchImpl: fetchMock,
    });
    const editableKeys = Object.keys(instances[0]?.editableFiles ?? {});
    expect(editableKeys).toEqual(['src/lib.rs']);
    expect(Object.keys(instances[0]?.hiddenTests ?? {})).toEqual(['tests/it.rs']);
  });

  it('omits hiddenTests when the exercise has no test files', async () => {
    const fetchMock = makeFetchMock({
      'api.github.com': makeTreeResponse([
        {
          path: 'benchmark/exercises/python/exercises/notest/instructions.md',
          type: 'blob',
          sha: 'a',
        },
        {
          path: 'benchmark/exercises/python/exercises/notest/sol.py',
          type: 'blob',
          sha: 'b',
        },
      ]),
      'instructions.md': makeRawResponse('Q'),
      'sol.py': makeRawResponse('S'),
    });
    const instances = await loadFromGithub({
      cacheDir,
      languages: ['python'],
      fetchImpl: fetchMock,
    });
    expect(instances[0]?.hiddenTests).toBeUndefined();
  });

  it('drops exercises that have only test files (no editable source)', async () => {
    const fetchMock = makeFetchMock({
      'api.github.com': makeTreeResponse([
        {
          path: 'benchmark/exercises/python/exercises/onlytest/instructions.md',
          type: 'blob',
          sha: 'a',
        },
        {
          path: 'benchmark/exercises/python/exercises/onlytest/test_only.py',
          type: 'blob',
          sha: 'b',
        },
      ]),
      'instructions.md': makeRawResponse('Q'),
      'test_only.py': makeRawResponse('T'),
    });
    const instances = await loadFromGithub({
      cacheDir,
      languages: ['python'],
      fetchImpl: fetchMock,
    });
    expect(instances).toHaveLength(0);
  });

  it('writes the cache file in JSON form for the next run to read', async () => {
    const fetchMock = makeFetchMock({
      'api.github.com': makeTreeResponse([
        {
          path: 'benchmark/exercises/go/exercises/sum/instructions.md',
          type: 'blob',
          sha: 'a',
        },
        {
          path: 'benchmark/exercises/go/exercises/sum/sum.go',
          type: 'blob',
          sha: 'b',
        },
      ]),
      'instructions.md': makeRawResponse('Sum'),
      'sum.go': makeRawResponse('package sum\n'),
    });
    await loadFromGithub({
      cacheDir,
      languages: ['go'],
      ref: 'abc',
      fetchImpl: fetchMock,
    });
    const cachePath = join(cacheDir, 'Aider-AI_aider', 'abc', 'go.index.json');
    const cached = JSON.parse(readFileSync(cachePath, 'utf8')) as Array<{
      instanceId: string;
    }>;
    expect(cached).toHaveLength(1);
    expect(cached[0]?.instanceId).toBe('go/sum');
  });
});
