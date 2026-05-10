/**
 * Smoke tests for the template adapter. These prove the scaffold works
 * out of the box — your benchmark-specific tests should go alongside
 * your replaced implementations.
 */
import { describe, it, expect } from 'vitest';
import { runBenchmark } from 'nexus-agents';
import { TemplateBenchmarkAdapter } from './adapter.js';

describe('TemplateBenchmarkAdapter', () => {
  it('runs end-to-end with default stub logic', async () => {
    const adapter = new TemplateBenchmarkAdapter();
    const summary = await runBenchmark(adapter, {});
    expect(summary.name).toBe('template-bench');
    expect(summary.total).toBeGreaterThan(0);
    expect(summary.passRate).toBeGreaterThanOrEqual(0);
    expect(summary.passRate).toBeLessThanOrEqual(1);
  });

  it('carries variant onto the summary', async () => {
    const adapter = new TemplateBenchmarkAdapter({ variant: 'mini' });
    const summary = await runBenchmark(adapter, {});
    expect(summary.variant).toBe('mini');
  });

  it('honors limit option', async () => {
    const adapter = new TemplateBenchmarkAdapter();
    const summary = await runBenchmark(adapter, {}, { limit: 1 });
    expect(summary.total).toBe(1);
  });
});
