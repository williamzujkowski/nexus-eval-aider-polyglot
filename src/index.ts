/**
 * Library entry point. Exposes the adapter so other projects can
 * compose it into their own harnesses (e.g., a dashboard that runs
 * multiple benchmarks).
 *
 * @module index
 */

export {
  TemplateBenchmarkAdapter,
  type BenchmarkInstance,
  type BenchmarkPrediction,
  type BenchmarkEvalResult,
  type BenchmarkConfig,
} from './adapter.js';
