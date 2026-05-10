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
 * v0.1 captures whether the model produced any parsable edits.
 *
 * v0.2 adds optional test-execution fields populated by the
 * per-language test runner when the instance carries `hiddenTests`.
 * `testsPassed` is the canonical pass/fail when present:
 *
 *   - `testsPassed === true`  → model's edits compile + tests pass
 *   - `testsPassed === false` → tests ran but failed (see testStderr)
 *   - `testsPassed === undefined` → no tests bundled (synthetic
 *     fixture) OR test execution was skipped via `runTests: false`
 *     adapter config
 */
export interface AiderEvalResult {
  readonly instanceId: string;
  readonly language: PolyglotLanguage;
  readonly editsProduced: boolean;
  readonly editedFileCount: number;
  readonly error?: string;
  /** v0.2: pass/fail of the per-language test runner (undefined when not run). */
  readonly testsPassed?: boolean;
  /** v0.2: name of the toolchain that ran (`pytest`, `go test`, …). */
  readonly testRunner?: string;
  /** v0.2: truncated stderr from the test runner — for diagnosis. */
  readonly testStderr?: string;
  /** v0.2: true iff the language toolchain wasn't installed. */
  readonly toolchainMissing?: boolean;
  /**
   * v0.3: number of agent turns the model used in agentic mode.
   * Undefined for v0.1/v0.2 single-shot runs.
   */
  readonly turnsUsed?: number;
  /**
   * v0.3: why the agent loop stopped — `agent-stopped` (model said
   * done), `turn-budget`, `tool-error`, `cancelled`. Undefined for
   * v0.1/v0.2 single-shot runs.
   */
  readonly agentStopReason?: string;
}

export interface AiderAdapterConfig {
  /**
   * Where to load exercises from.
   *
   * - `'fixture'` (default): bundled six-language smoke set
   * - `'github'`: fetch from `Aider-AI/aider` on GitHub
   * - `'github:<ref>'`: pin a branch / tag / commit SHA
   * - any other string: treat as an absolute path to a local Aider
   *   `benchmark/exercises/` directory
   */
  readonly source?: 'fixture' | 'github' | string;
  /** Filter the exercise set to specific languages. */
  readonly languages?: ReadonlyArray<PolyglotLanguage>;
  /** v0.2 GitHub-fetch caching root. */
  readonly cacheDir?: string;
  /**
   * v0.2: actually run the per-language toolchain against the model's
   * edits to get test-based pass/fail. Default: `true`. Set to `false`
   * for fast smoke runs where pass/fail = "did the model produce
   * extractable edits" is enough.
   *
   * When `true` and the instance has no `hiddenTests`, falls back to
   * the v0.1 verdict (`editsProduced`).
   */
  readonly runTests?: boolean;
  /** v0.2: per-instance test timeout. Default: 60_000ms. */
  readonly testTimeoutMs?: number;
  /**
   * v0.3: drive the model as an agent that can iterate on test failures
   * instead of single-shot edit-then-evaluate. Requires
   * `nexus-agents >= 2.72.0` (the IAgenticAdapter primitive). When
   * `true`, `runInstance` exposes `read_file` / `write_file` /
   * `run_tests` tools to the model and lets it iterate; passing /
   * failing is decided by the final test verdict, not the first edit.
   * Default: `false` (v0.2 single-shot behaviour).
   */
  readonly agenticMode?: boolean;
  /** v0.3: turn budget for agentic mode. Defaults to the model's profile recommendation. */
  readonly agenticTurnBudget?: number;
}
