/**
 * Aider polyglot exercise loader.
 *
 * v0.1 scope:
 *   - Bundled fixture (one exercise per language, ~6 instances) — for
 *     smoke testing without network or any external checkout.
 *   - Local-path source — point at an existing Aider-AI/aider checkout's
 *     `benchmark/exercises/` directory.
 *
 * v0.2 follow-up: GitHub-fetch source. Aider's exercises live under
 * `Aider-AI/aider/benchmark/exercises/<lang>/exercises/<exercise-name>/`
 * — we'll fetch the manifest + per-exercise files via raw URLs.
 *
 * @module runner/instance-loader
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import type { AiderInstance, PolyglotLanguage } from '../types.js';
import { loadFromGithub, type LoadFromGithubOptions } from './github-loader.js';

const FIXTURE_LANGUAGES: readonly PolyglotLanguage[] = [
  'python',
  'javascript',
  'typescript',
  'go',
  'rust',
  'cpp',
];

const FIXTURE_FILE_BY_LANGUAGE: Record<PolyglotLanguage, { path: string; starter: string }> = {
  python: {
    path: 'solve.py',
    starter: 'def solve(x: str) -> str:\n    """TODO: return "ok" when input is valid."""\n    return ""\n',
  },
  javascript: {
    path: 'solve.js',
    starter: '/** TODO: return "ok" when input is valid. */\nfunction solve(x) {\n  return "";\n}\nmodule.exports = { solve };\n',
  },
  typescript: {
    path: 'solve.ts',
    starter: '/** TODO: return "ok" when input is valid. */\nexport function solve(x: string): string {\n  return "";\n}\n',
  },
  go: {
    path: 'solve.go',
    starter: 'package solve\n\n// TODO: return "ok" when input is valid.\nfunc Solve(x string) string {\n\treturn ""\n}\n',
  },
  rust: {
    path: 'src/lib.rs',
    starter: '// TODO: return "ok" when input is valid.\npub fn solve(_x: &str) -> &\'static str {\n    ""\n}\n',
  },
  cpp: {
    path: 'solve.cpp',
    starter: '#include <string>\n\n// TODO: return "ok" when input is valid.\nstd::string solve(const std::string& x) {\n    (void)x;\n    return "";\n}\n',
  },
};

/**
 * Load Aider polyglot exercises.
 *
 * @param source - 'fixture' (default), 'github' (v0.2 — fetches from
 *   `Aider-AI/aider/benchmark/exercises/` via the GitHub Trees API +
 *   raw.githubusercontent.com, with on-disk caching), 'github:<ref>'
 *   to pin a specific branch / tag / commit SHA, or an absolute path
 *   to an Aider-AI/aider checkout's `benchmark/exercises/` directory
 * @param languages - optional filter
 * @param maxInstances - optional cap
 * @param githubOptions - reserved for tests / power users to inject a
 *   `fetchImpl` mock or override the default cache dir
 */
export async function loadAiderInstances(args: {
  readonly source?: 'fixture' | 'github' | string;
  readonly languages?: ReadonlyArray<PolyglotLanguage>;
  readonly maxInstances?: number;
  readonly githubOptions?: LoadFromGithubOptions;
}): Promise<readonly AiderInstance[]> {
  const source = args.source ?? 'fixture';

  let all: readonly AiderInstance[];
  if (source === 'fixture') {
    all = loadBundledFixture();
  } else if (source === 'github' || source.startsWith('github:')) {
    const ref = source.startsWith('github:') ? source.slice('github:'.length) : undefined;
    all = await loadFromGithub({
      ...(args.githubOptions ?? {}),
      ...(ref !== undefined && ref !== '' && { ref }),
      ...(args.languages !== undefined && { languages: args.languages }),
    });
  } else {
    all = loadFromDirectory(source);
  }

  let filtered = all;
  if (args.languages !== undefined && args.languages.length > 0) {
    const allowed = new Set(args.languages);
    filtered = filtered.filter((i) => allowed.has(i.language));
  }
  if (args.maxInstances !== undefined && args.maxInstances < filtered.length) {
    filtered = filtered.slice(0, args.maxInstances);
  }
  return filtered;
}

/**
 * Bundled fixture — one stub exercise per language. The exercise asks
 * the model to make `solve("foo")` return "ok". Useful for smoke tests
 * + verifying the harness pipeline without an external checkout.
 */
function loadBundledFixture(): readonly AiderInstance[] {
  return FIXTURE_LANGUAGES.map((lang) => {
    const file = FIXTURE_FILE_BY_LANGUAGE[lang];
    return {
      instanceId: `fixture/${lang}/return-ok`,
      language: lang,
      problemStatement:
        'Modify `solve(x)` to return the string "ok" when called with any non-empty input. ' +
        'Empty input should still return the empty string.',
      editableFiles: { [file.path]: file.starter },
    };
  });
}

/**
 * Walk an Aider-AI/aider/benchmark/exercises checkout. The directory
 * structure is:
 *
 *   <root>/<language>/exercises/<exercise-name>/
 *     ├── .docs/ (instructions, optional)
 *     ├── instructions.md
 *     ├── solution-source-files (e.g. *.py, *.js, *.ts)
 *     └── tests/ or *_test.py / *.test.ts (omitted from editableFiles)
 *
 * The structure varies by language; this loader applies a few heuristics
 * (test-file name patterns + dir patterns) and reports what it
 * recognised.
 */
function loadFromDirectory(rootPath: string): readonly AiderInstance[] {
  if (!existsSync(rootPath)) {
    throw new Error(`Aider polyglot path not found: ${rootPath}`);
  }
  const out: AiderInstance[] = [];
  for (const lang of FIXTURE_LANGUAGES) {
    const langRoot = join(rootPath, lang, 'exercises');
    if (!existsSync(langRoot)) continue;
    for (const exercise of readdirSync(langRoot)) {
      const exDir = join(langRoot, exercise);
      if (!statSync(exDir).isDirectory()) continue;
      const inst = readExercise(exDir, lang, exercise);
      if (inst !== null) out.push(inst);
    }
  }
  return out;
}

function readExercise(
  exDir: string,
  lang: PolyglotLanguage,
  exerciseName: string
): AiderInstance | null {
  const instructionsPath = join(exDir, 'instructions.md');
  if (!existsSync(instructionsPath)) return null;
  const problemStatement = readFileSync(instructionsPath, 'utf8');

  const editable: Record<string, string> = {};
  walkAndCollect(exDir, exDir, editable, lang);
  if (Object.keys(editable).length === 0) return null;

  return {
    instanceId: `${lang}/${exerciseName}`,
    language: lang,
    problemStatement,
    editableFiles: editable,
  };
}

const TEST_FILE_PATTERNS_BY_LANG: Record<PolyglotLanguage, RegExp[]> = {
  python: [/_test\.py$/i, /test_.*\.py$/i],
  javascript: [/\.test\.js$/i, /\.spec\.js$/i],
  typescript: [/\.test\.ts$/i, /\.spec\.ts$/i],
  go: [/_test\.go$/i],
  rust: [/^tests\//i],
  cpp: [/_test\.cpp$/i, /^tests?\//i],
};

const SKIP_DIR_PATTERNS = [/^\.docs$/, /^\.meta$/, /^node_modules$/, /^target$/, /^build$/];

function walkAndCollect(
  baseDir: string,
  currentDir: string,
  out: Record<string, string>,
  lang: PolyglotLanguage
): void {
  for (const entry of readdirSync(currentDir)) {
    const entryPath = join(currentDir, entry);
    const rel = relative(baseDir, entryPath);
    const stat = statSync(entryPath);
    if (stat.isDirectory()) {
      if (SKIP_DIR_PATTERNS.some((p) => p.test(entry))) continue;
      walkAndCollect(baseDir, entryPath, out, lang);
      continue;
    }
    if (entry === 'instructions.md') continue;
    const isTest = TEST_FILE_PATTERNS_BY_LANG[lang].some((p) => p.test(rel));
    if (isTest) continue;
    out[rel] = readFileSync(entryPath, 'utf8');
  }
}
