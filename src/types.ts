/**
 * Public type contracts for the Aider polyglot harness.
 *
 * Kept in their own module so adapter / loader / runner can share them
 * without circular imports, and so consumers can import only the types
 * (no transitive runtime cost).
 *
 * @module types
 */

export type PolyglotLanguage =
  | 'python'
  | 'javascript'
  | 'typescript'
  | 'go'
  | 'rust'
  | 'cpp';

/**
 * One Aider polyglot exercise. Aider's own benchmark walks
 * `Aider-AI/aider/benchmark/exercises/<lang>/exercises/<name>/` and
 * loads each as a self-contained problem with one or two starter
 * source files plus a hidden test file.
 *
 * `editableFiles` is the set of files the model is allowed to modify.
 * Test files are filtered out at load time so the model never sees them.
 *
 * `contextFiles` is reserved for future polyglot variants that bundle
 * read-only context (e.g. shared helper libs). v0.1 doesn't surface it
 * but the prompt template already supports it.
 */
export interface AiderInstance {
  readonly instanceId: string;
  readonly language: PolyglotLanguage;
  readonly problemStatement: string;
  readonly editableFiles: Readonly<Record<string, string>>;
  readonly contextFiles?: Readonly<Record<string, string>>;
  /**
   * v0.2: per-language hidden test files bundled with the exercise.
   * The model is NOT shown these in the prompt — they're materialised
   * to disk alongside the model's edits at evaluation time and run by
   * the language-specific toolchain (pytest / go test / cargo test /
   * vitest / ctest).
   *
   * Keys are paths relative to the exercise root (e.g.
   * `tests/test_solve.py`, `solve_test.go`). Values are the full file
   * contents.
   *
   * Optional because pre-v0.2 fixtures (the bundled six-language smoke
   * set) don't ship hidden tests — they're synthetic exercises whose
   * pass/fail is "did the model emit any non-empty edits". GitHub-
   * fetched and local-path-loaded exercises populate this field.
   */
  readonly hiddenTests?: Readonly<Record<string, string>>;
}

/**
 * One model prediction for an Aider polyglot instance — the full
 * updated content the model emitted for each editable file.
 */
export interface AiderPrediction {
  readonly instanceId: string;
  readonly editedFiles: Readonly<Record<string, string>>;
  readonly modelLabel: string;
  readonly durationMs: number;
}

/**
 * Verdict for one Aider polyglot instance.
 *
 * v0.1 captures whether the model produced any parsable edits;
 * v0.3 follow-up will run the language-specific test suite against
 * the emitted edits and turn that into the canonical pass/fail.
 */
export interface AiderEvalResult {
  readonly instanceId: string;
  readonly language: PolyglotLanguage;
  readonly editsProduced: boolean;
  readonly editedFileCount: number;
  readonly error?: string;
}

export interface AiderAdapterConfig {
  /**
   * Where to load exercises from.
   *
   * - `'fixture'` (default): bundled six-language smoke set
   * - `'github'`: fetch from `Aider-AI/aider` on GitHub (v0.2 — not yet implemented)
   * - any other string: treat as an absolute path to a local Aider
   *   `benchmark/exercises/` directory
   */
  readonly source?: 'fixture' | 'github' | string;
  /** Filter the exercise set to specific languages. */
  readonly languages?: ReadonlyArray<PolyglotLanguage>;
  /** Reserved for v0.2 GitHub-fetch caching. */
  readonly cacheDir?: string;
}
