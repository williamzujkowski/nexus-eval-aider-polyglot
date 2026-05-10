/**
 * GitHub-fetch loader for Aider polyglot exercises (v0.2).
 *
 * Walks `Aider-AI/aider/benchmark/exercises/<lang>/exercises/<exercise-name>/`
 * via the GitHub Trees API and fetches each exercise's source files via
 * raw.githubusercontent.com. Result is cached to disk per-(commit-SHA,
 * language) so repeat runs don't re-fetch.
 *
 * Why pin a commit SHA: Aider-AI/aider's main branch evolves; without
 * pinning, runs on different days produce different scores. Operators
 * who want the bleeding edge can pass an explicit SHA / 'main' override.
 *
 * Why fetch via raw URLs (not git clone): keeps the dep tree minimal
 * (no `git`, no `node-git`), works in any sandbox, plays nicely with
 * the existing on-disk cache.
 *
 * @module runner/github-loader
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

import type { AiderInstance, PolyglotLanguage } from '../types.js';

/**
 * Default upstream commit SHA pinned for reproducibility. Operators
 * who want a different snapshot pass `--source github:<sha>` or call
 * `loadFromGithub({ ref })` directly.
 *
 * Bumped manually when validating against a newer Aider-AI/aider
 * release. Selected: tip of `Aider-AI/aider` main as of this v0.2 cut.
 */
export const DEFAULT_AIDER_REF = 'main';

/**
 * Languages we know how to walk on-disk in upstream's directory layout.
 * Mirrors FIXTURE_LANGUAGES in instance-loader.ts.
 */
const LANGUAGES_TO_FETCH: readonly PolyglotLanguage[] = [
  'python',
  'javascript',
  'typescript',
  'go',
  'rust',
  'cpp',
];

const TEST_FILE_PATTERNS_BY_LANG: Record<PolyglotLanguage, RegExp[]> = {
  python: [/_test\.py$/i, /test_.*\.py$/i],
  javascript: [/\.test\.js$/i, /\.spec\.js$/i],
  typescript: [/\.test\.ts$/i, /\.spec\.ts$/i],
  go: [/_test\.go$/i],
  rust: [/(?:^|\/)tests\//i],
  cpp: [/_test\.cpp$/i, /(?:^|\/)tests?\//i],
};

const SKIP_DIR_PATTERNS = [/^\.docs$/, /^\.meta$/, /^node_modules$/, /^target$/, /^build$/];

const DEFAULT_REPO = 'Aider-AI/aider';
const DEFAULT_BENCH_PATH = 'benchmark/exercises';

export interface LoadFromGithubOptions {
  /** GitHub repo slug. Default: `Aider-AI/aider`. */
  readonly repo?: string;
  /** Branch / tag / commit SHA. Default: `DEFAULT_AIDER_REF`. */
  readonly ref?: string;
  /**
   * Path within the repo where the exercises live. Default:
   * `benchmark/exercises`. Override only if upstream restructures.
   */
  readonly benchPath?: string;
  /** Cache root. Default: `~/.nexus-eval-aider-polyglot/cache/`. */
  readonly cacheDir?: string;
  /**
   * Filter the exercise set to specific languages. Default: all six.
   */
  readonly languages?: ReadonlyArray<PolyglotLanguage>;
  /**
   * `fetch` injection point — only `globalThis.fetch` is used by default;
   * tests inject a mock here without monkey-patching globals.
   */
  readonly fetchImpl?: typeof fetch;
}

export async function loadFromGithub(
  options: LoadFromGithubOptions = {}
): Promise<readonly AiderInstance[]> {
  const repo = options.repo ?? DEFAULT_REPO;
  const ref = options.ref ?? DEFAULT_AIDER_REF;
  const benchPath = options.benchPath ?? DEFAULT_BENCH_PATH;
  const cacheRoot =
    options.cacheDir ?? join(homedir(), '.nexus-eval-aider-polyglot', 'cache');
  const cacheDir = join(cacheRoot, slugify(repo), slugify(ref));
  const langsToFetch = options.languages ?? LANGUAGES_TO_FETCH;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  const out: AiderInstance[] = [];
  for (const lang of langsToFetch) {
    const langInstances = await fetchLanguage(
      repo,
      ref,
      benchPath,
      lang,
      cacheDir,
      fetchImpl
    );
    out.push(...langInstances);
  }
  return out;
}

async function fetchLanguage(
  repo: string,
  ref: string,
  benchPath: string,
  lang: PolyglotLanguage,
  cacheDir: string,
  fetchImpl: typeof fetch
): Promise<readonly AiderInstance[]> {
  // 1. Check cache: did we already index this (repo, ref, lang)?
  const langCachePath = join(cacheDir, `${lang}.index.json`);
  if (existsSync(langCachePath)) {
    return JSON.parse(readFileSync(langCachePath, 'utf8')) as readonly AiderInstance[];
  }

  // 2. List exercises under <repo>/<benchPath>/<lang>/exercises/
  const treeUrl = `https://api.github.com/repos/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`;
  const tree = await fetchTreeWithRetry(treeUrl, fetchImpl);
  const exerciseRootPrefix = `${benchPath}/${lang}/exercises/`;

  // Collect entries grouped by exercise dir.
  const byExercise = new Map<string, GitHubTreeEntry[]>();
  for (const entry of tree.tree) {
    if (entry.type !== 'blob') continue;
    if (!entry.path.startsWith(exerciseRootPrefix)) continue;
    const rest = entry.path.slice(exerciseRootPrefix.length);
    const slash = rest.indexOf('/');
    if (slash === -1) continue; // expect <exercise>/<file>
    const exerciseName = rest.slice(0, slash);
    const fileRelPath = rest.slice(slash + 1);
    if (shouldSkip(fileRelPath, lang)) continue;
    const list = byExercise.get(exerciseName) ?? [];
    list.push({ ...entry, exerciseRelPath: fileRelPath });
    byExercise.set(exerciseName, list);
  }

  // 3. For each exercise, fetch instructions.md + the editable files.
  const out: AiderInstance[] = [];
  for (const [exerciseName, entries] of byExercise) {
    const inst = await fetchExercise(
      repo,
      ref,
      exerciseRootPrefix,
      exerciseName,
      entries,
      lang,
      fetchImpl
    );
    if (inst !== null) out.push(inst);
  }

  // 4. Cache the per-language index for next run.
  mkdirSync(dirname(langCachePath), { recursive: true });
  writeFileSync(langCachePath, JSON.stringify(out, null, 2), 'utf8');
  return out;
}

interface GitHubTreeEntry {
  readonly path: string;
  readonly type: string;
  readonly sha: string;
  // Synthesised: relative path within the exercise dir.
  readonly exerciseRelPath?: string;
}

interface GitHubTreeResponse {
  readonly tree: readonly GitHubTreeEntry[];
  readonly truncated: boolean;
}

async function fetchTreeWithRetry(
  url: string,
  fetchImpl: typeof fetch
): Promise<GitHubTreeResponse> {
  // GitHub's anonymous rate limit is 60/hr — one request per language
  // is well under that. No retry budget for now; if we hit a rate-limit
  // surface a clear error so operators set GITHUB_TOKEN.
  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
  };
  const token = process.env['GITHUB_TOKEN'];
  if (token !== undefined && token !== '') {
    headers.authorization = `Bearer ${token}`;
  }
  const res = await fetchImpl(url, { headers });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `GitHub Trees API failed: ${String(res.status)} ${res.statusText}\n` +
        `URL: ${url}\nBody: ${body.slice(0, 500)}\n` +
        `If rate-limited, set GITHUB_TOKEN to a personal access token.`
    );
  }
  const json = (await res.json()) as GitHubTreeResponse;
  if (json.truncated) {
    // Aider's exercise tree per language is small (~100s of entries),
    // not megabytes; we shouldn't actually hit truncation, but warn
    // explicitly if we ever do.
    process.stderr.write(
      'WARN: GitHub Trees API result was truncated. Some exercises may be missing.\n'
    );
  }
  return json;
}

async function fetchExercise(
  repo: string,
  ref: string,
  exerciseRootPrefix: string,
  exerciseName: string,
  entries: readonly GitHubTreeEntry[],
  lang: PolyglotLanguage,
  fetchImpl: typeof fetch
): Promise<AiderInstance | null> {
  const instructionsEntry = entries.find((e) => e.exerciseRelPath === 'instructions.md');
  if (instructionsEntry === undefined) return null;
  const editableEntries = entries.filter((e) => e.exerciseRelPath !== 'instructions.md');
  if (editableEntries.length === 0) return null;

  const problemStatement = await fetchRawFile(
    repo,
    ref,
    `${exerciseRootPrefix}${exerciseName}/instructions.md`,
    fetchImpl
  );
  const editable: Record<string, string> = {};
  for (const e of editableEntries) {
    if (e.exerciseRelPath === undefined) continue;
    const fullPath = `${exerciseRootPrefix}${exerciseName}/${e.exerciseRelPath}`;
    editable[e.exerciseRelPath] = await fetchRawFile(repo, ref, fullPath, fetchImpl);
  }

  return {
    instanceId: `${lang}/${exerciseName}`,
    language: lang,
    problemStatement,
    editableFiles: editable,
  };
}

async function fetchRawFile(
  repo: string,
  ref: string,
  path: string,
  fetchImpl: typeof fetch
): Promise<string> {
  const url = `https://raw.githubusercontent.com/${repo}/${encodeURIComponent(ref)}/${path
    .split('/')
    .map(encodeURIComponent)
    .join('/')}`;
  const res = await fetchImpl(url);
  if (!res.ok) {
    throw new Error(`Raw file fetch failed: ${String(res.status)} ${res.statusText} (${url})`);
  }
  return res.text();
}

function shouldSkip(relPath: string, lang: PolyglotLanguage): boolean {
  if (relPath === 'instructions.md') return false; // captured separately
  for (const dirPattern of SKIP_DIR_PATTERNS) {
    const firstSegment = relPath.split('/')[0] ?? '';
    if (dirPattern.test(firstSegment)) return true;
  }
  for (const testPattern of TEST_FILE_PATTERNS_BY_LANG[lang]) {
    if (testPattern.test(relPath)) return true;
  }
  return false;
}

function slugify(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]/g, '_');
}
