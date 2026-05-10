/**
 * Template BenchmarkAdapter implementation.
 *
 * Replace everything here with your benchmark-specific logic. The four
 * methods are all you need to implement; `runBenchmark()` from
 * `nexus-agents` handles the harness (concurrency, timeouts, progress,
 * partial failure, summary).
 *
 * Type parameters:
 * - TInstance: one task/problem in your benchmark
 * - TPrediction: what your solver produces (patch, code, answer, etc.)
 * - TEvalResult: what your evaluator produces (pass/fail + context)
 *
 * @module adapter
 */

import type {
  BenchmarkAdapter,
  BenchmarkRunContext,
  BenchmarkRunSummary,
} from 'nexus-agents';

// ============================================================================
// Replace these types with your benchmark's actual shapes
// ============================================================================

/** One problem from your benchmark dataset. */
export interface BenchmarkInstance {
  readonly id: string;
  readonly prompt: string;
  readonly expectedOutput?: string;
  // Add whatever fields your dataset has.
}

/** What your solver produces for one instance. */
export interface BenchmarkPrediction {
  readonly instanceId: string;
  readonly output: string;
  readonly durationMs: number;
}

/** Verdict for one instance. Adapter decides pass/fail via isPass(). */
export interface BenchmarkEvalResult {
  readonly instanceId: string;
  readonly passed: boolean;
  readonly reason?: string;
}

// ============================================================================
// Configuration — what loadInstances() takes
// ============================================================================

export interface BenchmarkConfig {
  /** Where the dataset lives. Replace with whatever your benchmark needs. */
  readonly datasetPath?: string;
  /** Variant within the benchmark family, if any (e.g., 'lite', 'full'). */
  readonly variant?: string;
}

// ============================================================================
// Adapter implementation
// ============================================================================

/**
 * Rename this class to reflect your benchmark (e.g., `HumanEvalAdapter`,
 * `MbppAdapter`).
 */
export class TemplateBenchmarkAdapter
  implements BenchmarkAdapter<BenchmarkInstance, BenchmarkPrediction, BenchmarkEvalResult>
{
  readonly name = 'template-bench'; // replace: 'humaneval', 'mbpp', etc.
  readonly variant: string | undefined;

  constructor(config: BenchmarkConfig = {}) {
    this.variant = config.variant;
  }

  /**
   * Load the task set. Called once per run.
   *
   * Your implementation should: read from disk / fetch from an API /
   * load a fixture. Return an array of instances the orchestrator will
   * iterate through.
   */
  loadInstances(_config: Record<string, unknown>): Promise<readonly BenchmarkInstance[]> {
    // TODO: replace with your dataset loader
    return Promise.resolve([
      { id: 'example-1', prompt: 'add two numbers' },
      { id: 'example-2', prompt: 'reverse a string' },
    ]);
  }

  /**
   * Run the solver on one instance. No evaluation here — this method
   * only produces the prediction.
   *
   * Your implementation typically calls out to a CLI / API / sandbox.
   * Honor `ctx.signal` to support cancellation.
   */
  runInstance(
    instance: BenchmarkInstance,
    ctx: BenchmarkRunContext
  ): Promise<BenchmarkPrediction> {
    // TODO: replace with your actual solver invocation
    const start = performance.now();
    void ctx; // use ctx.signal, ctx.timeoutMs, ctx.onProgress as needed
    return Promise.resolve({
      instanceId: instance.id,
      output: `stub output for ${instance.id}`,
      durationMs: Math.round(performance.now() - start),
    });
  }

  /**
   * Evaluate a prediction against ground truth. Returns your
   * benchmark-specific verdict — pass/fail semantics live here.
   */
  evaluate(
    instance: BenchmarkInstance,
    prediction: BenchmarkPrediction
  ): Promise<BenchmarkEvalResult> {
    // TODO: replace with your actual evaluation logic (exec tests, diff
    // against expected output, grade with an LLM, etc.)
    const passed =
      instance.expectedOutput === undefined
        ? prediction.output.length > 0
        : prediction.output === instance.expectedOutput;
    return Promise.resolve({
      instanceId: instance.id,
      passed,
      ...(passed ? {} : { reason: 'output did not match expected' }),
    });
  }

  /** Does this verdict count as a pass? Usually trivial. */
  isPass(result: BenchmarkEvalResult): boolean {
    return result.passed;
  }

  /**
   * Aggregate verdicts into a summary. Should be pure + deterministic.
   * Put benchmark-specific breakdowns (by category, difficulty, etc.)
   * into `metadata`.
   */
  summarize(
    results: readonly BenchmarkEvalResult[],
    runTimeMs: number
  ): BenchmarkRunSummary {
    const passed = results.filter((r) => r.passed).length;
    return {
      name: this.name,
      variant: this.variant,
      total: results.length,
      passed,
      passRate: results.length > 0 ? passed / results.length : 0,
      runTimeMs,
      metadata: {
        // Add benchmark-specific breakdowns here, e.g.:
        // passByCategory: { ... },
        // datasetVersion: '...',
      },
    };
  }
}
