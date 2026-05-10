/**
 * Aider polyglot BenchmarkAdapter — clean-room implementation.
 *
 * Self-contained: depends ONLY on public `nexus-agents` types
 * (`BenchmarkAdapter`, `IModelAdapter`, …). No internal-helper imports.
 *
 * v0.1 (this release): model-only baseline. Loads exercises from a
 * bundled fixture or a local Aider-AI/aider checkout, sends each one
 * to the configured `IModelAdapter`, parses out per-file edited
 * contents. Pass/fail = "did the model produce any non-empty edits"
 * — NOT test-based pass/fail.
 *
 * v0.2 follow-up: GitHub-fetch loader (so operators don't need a local
 * checkout).
 *
 * v0.3 follow-up: iterate-on-test-failures loop via `ICliAdapter`
 * against the language toolchain (Python / Node / Go / Rust / cpp).
 *
 * @module adapter
 */

import type {
  BenchmarkAdapter,
  BenchmarkRunContext,
  BenchmarkRunSummary,
  IModelAdapter,
} from 'nexus-agents';

import { loadAiderInstances } from './runner/instance-loader.js';
import { generatePrediction } from './runner/agent-invoker.js';
import { runTests, type RunTestsOptions } from './runner/test-runner.js';
import { runAgenticFlow, type AgenticFlowResult } from './runner/agentic-flow.js';
import type {
  AiderAdapterConfig,
  AiderEvalResult,
  AiderInstance,
  AiderPrediction,
  PolyglotLanguage,
} from './types.js';

export class AiderPolyglotAdapter
  implements BenchmarkAdapter<AiderInstance, AiderPrediction, AiderEvalResult>
{
  readonly name = 'aider-polyglot';
  // No `variant` in v1 — polyglot is one dataset shape.

  private readonly modelAdapter: IModelAdapter;
  private readonly config: AiderAdapterConfig;
  /**
   * Model-only verdict captured during runInstance (so the test runner
   * gets executed in evaluate() but we still know what the model
   * produced if we choose to skip tests).
   */
  private readonly modelOnlyVerdictCache = new Map<string, AiderEvalResult>();

  constructor(modelAdapter: IModelAdapter, config: AiderAdapterConfig = {}) {
    this.modelAdapter = modelAdapter;
    this.config = config;
  }

  loadInstances(_runConfig: Record<string, unknown>): Promise<readonly AiderInstance[]> {
    return loadAiderInstances({
      ...(this.config.source !== undefined && { source: this.config.source }),
      ...(this.config.languages !== undefined && { languages: this.config.languages }),
    });
  }

  async runInstance(
    instance: AiderInstance,
    ctx: BenchmarkRunContext
  ): Promise<AiderPrediction> {
    void ctx;
    if (this.config.agenticMode === true) {
      return this.runInstanceAgentic(instance, ctx);
    }
    const result = await generatePrediction(instance, this.modelAdapter);

    if (!result.ok) {
      const empty: AiderPrediction = {
        instanceId: instance.instanceId,
        editedFiles: {},
        modelLabel: this.modelAdapter.modelId,
        durationMs: 0,
      };
      this.modelOnlyVerdictCache.set(instance.instanceId, {
        instanceId: instance.instanceId,
        language: instance.language,
        editsProduced: false,
        editedFileCount: 0,
        error: result.error.message,
      });
      return empty;
    }

    const editedCount = Object.keys(result.value.editedFiles).length;
    this.modelOnlyVerdictCache.set(instance.instanceId, {
      instanceId: instance.instanceId,
      language: instance.language,
      editsProduced: editedCount > 0,
      editedFileCount: editedCount,
      ...(editedCount === 0 && { error: 'model returned no parsable edits' }),
    });
    return result.value;
  }

  /**
   * v0.3: run the agent loop with read_file / write_file / run_tests
   * tools, scoped to a per-instance tmpdir workspace. The final test
   * verdict from the loop becomes the EvalResult; evaluate() picks it
   * up from the cache.
   */
  private async runInstanceAgentic(
    instance: AiderInstance,
    ctx: BenchmarkRunContext
  ): Promise<AiderPrediction> {
    const flowResult = await runAgenticFlow(instance, this.modelAdapter, {
      ...(this.config.agenticTurnBudget !== undefined && {
        turnBudget: this.config.agenticTurnBudget,
      }),
      ...(this.config.testTimeoutMs !== undefined && { testTimeoutMs: this.config.testTimeoutMs }),
      ...(this.testRunnerSpawnImpl !== undefined && { spawnImpl: this.testRunnerSpawnImpl }),
      ...(ctx.signal !== undefined && { signal: ctx.signal }),
    });
    this.cacheAgenticVerdict(instance, flowResult);
    return flowResult.prediction;
  }

  private cacheAgenticVerdict(instance: AiderInstance, flow: AgenticFlowResult): void {
    const editedCount = Object.keys(flow.editedFiles).length;
    const baseEdits = Object.keys(instance.editableFiles).length;
    // editedCount counts every editable path (since we materialise the
    // starter set and only flip on write_file). Use a "did the model
    // actually call write_file at least once" heuristic instead.
    const wroteSomething = editedCount > 0 && hasNonStarter(instance, flow.editedFiles);
    this.modelOnlyVerdictCache.set(instance.instanceId, {
      instanceId: instance.instanceId,
      language: instance.language,
      editsProduced: wroteSomething,
      editedFileCount: wroteSomething ? editedCount : 0,
      turnsUsed: flow.agentRun.turnsUsed,
      agentStopReason: flow.agentRun.stopReason,
      ...(flow.testResult !== null && {
        testsPassed: flow.testResult.passed,
        testRunner: flow.testResult.testRunner,
        ...(flow.testResult.stderr.length > 0 && { testStderr: flow.testResult.stderr }),
        ...(flow.testResult.toolchainMissing && {
          toolchainMissing: true,
          error: `${flow.testResult.testRunner} not found in PATH (toolchain missing)`,
        }),
      }),
      // Fallback verdict when the agent never ran tests.
      ...(flow.testResult === null && !wroteSomething && {
        error: 'agent emitted no edits before stopping',
      }),
    });
    void baseEdits;
  }

  /**
   * v0.2: when the instance ships `hiddenTests` AND `runTests` is on
   * (default), materialises the workspace and runs the language
   * toolchain. Otherwise returns the v0.1 model-only verdict.
   */
  async evaluate(
    instance: AiderInstance,
    prediction: AiderPrediction
  ): Promise<AiderEvalResult> {
    const baseVerdict = this.modelOnlyVerdictCache.get(instance.instanceId) ?? {
      instanceId: instance.instanceId,
      language: instance.language,
      editsProduced: Object.keys(prediction.editedFiles).length > 0,
      editedFileCount: Object.keys(prediction.editedFiles).length,
    };

    const runTestsEnabled = this.config.runTests ?? true;
    const hasHiddenTests =
      instance.hiddenTests !== undefined && Object.keys(instance.hiddenTests).length > 0;
    const editsExist = Object.keys(prediction.editedFiles).length > 0;
    if (!runTestsEnabled || !hasHiddenTests || !editsExist) {
      return baseVerdict;
    }

    const testRunOptions: RunTestsOptions = {};
    if (this.config.testTimeoutMs !== undefined) {
      Object.assign(testRunOptions, { timeoutMs: this.config.testTimeoutMs });
    }
    if (this.testRunnerSpawnImpl !== undefined) {
      Object.assign(testRunOptions, { spawnImpl: this.testRunnerSpawnImpl });
    }
    const testResult = await runTests(instance, prediction, testRunOptions);

    return {
      ...baseVerdict,
      testsPassed: testResult.passed,
      testRunner: testResult.testRunner,
      ...(testResult.stderr.length > 0 && { testStderr: testResult.stderr }),
      ...(testResult.toolchainMissing && { toolchainMissing: true }),
      ...(testResult.toolchainMissing && {
        error: `${testResult.testRunner} not found in PATH (toolchain missing)`,
      }),
    };
  }

  /**
   * Test-runner spawn injection point (constructor-set after-the-fact
   * via a setter pattern is overkill for v0.2; tests inject by passing
   * a spawn through the test-runner directly).
   */
  private testRunnerSpawnImpl: RunTestsOptions['spawnImpl'];

  /** Set spawn for tests. Production callers don't use this. */
  setSpawnImplForTests(impl: RunTestsOptions['spawnImpl']): void {
    this.testRunnerSpawnImpl = impl;
  }

  isPass(result: AiderEvalResult): boolean {
    if (result.testsPassed !== undefined) return result.testsPassed;
    return result.editsProduced && result.error === undefined;
  }

  /**
   * Per-language pass-rate breakdown — Aider polyglot's headline signal
   * is multi-language differentials. Top systems often score very
   * differently on, e.g., Rust vs JavaScript.
   */
  summarize(
    results: readonly AiderEvalResult[],
    runTimeMs: number
  ): BenchmarkRunSummary {
    const passed = results.filter((r) => this.isPass(r)).length;
    const byLanguage: Record<PolyglotLanguage, { total: number; passed: number }> = {
      python: { total: 0, passed: 0 },
      javascript: { total: 0, passed: 0 },
      typescript: { total: 0, passed: 0 },
      go: { total: 0, passed: 0 },
      rust: { total: 0, passed: 0 },
      cpp: { total: 0, passed: 0 },
    };
    for (const r of results) {
      byLanguage[r.language].total += 1;
      if (this.isPass(r)) byLanguage[r.language].passed += 1;
    }

    return {
      name: this.name,
      variant: 'default',
      total: results.length,
      passed,
      passRate: results.length > 0 ? passed / results.length : 0,
      runTimeMs,
      metadata: {
        byLanguage: Object.fromEntries(
          Object.entries(byLanguage)
            .filter(([, b]) => b.total > 0)
            .map(([lang, b]) => [
              lang,
              { ...b, passRate: b.total > 0 ? b.passed / b.total : 0 },
            ])
        ),
        note: 'pass/fail reflects edit generation only. Run language-specific test suites against the emitted edited files for test-based resolution (v0.3 follow-up).',
      },
    };
  }
}

/**
 * Did the agent actually overwrite any of the starter editable files,
 * or are they still in their starter form? Used to flag "model emitted
 * tool calls but never called write_file".
 */
function hasNonStarter(
  instance: AiderInstance,
  editedFiles: Readonly<Record<string, string>>
): boolean {
  for (const [path, currentContent] of Object.entries(editedFiles)) {
    const starter = instance.editableFiles[path];
    if (starter === undefined) return true;
    if (currentContent !== starter) return true;
  }
  return false;
}
