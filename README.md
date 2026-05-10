# nexus-eval-aider-polyglot

Aider polyglot evaluation harness for [nexus-agents](https://github.com/williamzujkowski/nexus-agents) — implements the `BenchmarkAdapter` contract from nexus-agents ≥ 2.33.1.

> **Status**: v0.3 — multi-turn agentic flow. Opt in with `agenticMode: true` (or `--agentic-mode`); the model gets `read_file` / `write_file` / `run_tests` tools and iterates until tests pass or the turn budget hits. Built on the `IAgenticAdapter` primitive from nexus-agents 2.72.1. v0.2 single-shot mode remains the default — agentic mode is opt-in because it's slower + more expensive per instance.

## Why Aider polyglot

The Aider polyglot benchmark scores LLM-driven code edits across **six languages** (Python, JavaScript, TypeScript, Go, Rust, C++). Where SWE-bench Pro asks "given a real issue, can the model produce a unified diff that fixes it?", Aider polyglot asks "given a small starter program in language X, can the model edit the right file(s) to satisfy the spec?".

What makes it useful alongside SWE-bench Pro:

- **Fast per-instance**: each exercise is small (1–3 files, ≤200 LOC), so a smoke run is minutes not hours.
- **Cross-language signal**: top systems often score very differently on, e.g., Rust vs. JavaScript. Single-language benchmarks hide this.
- **Edit format pressure**: the harness rewards models that emit clean whole-file edits to the *correct path*, not models that generate plausible code in the wrong place.
- **Cheap to iterate**: useful for shaking out routing decisions, prompt regressions, and adapter bugs without burning a full Pro run.

This repo follows the [nexus-agents harness-extraction policy](https://github.com/williamzujkowski/nexus-agents/issues/2514) (originally [#1960](https://github.com/williamzujkowski/nexus-agents/issues/1960)) — benchmarks live in standalone `nexus-eval-*` repos so they can evolve independently of the core.

## Install

```sh
npm install nexus-eval-aider-polyglot nexus-agents
```

`nexus-agents` is a peer dependency.

## Quick start (CLI)

```sh
# Set the OpenAI-compat endpoint
export OPENAI_API_KEY=sk-...
export OPENAI_BASE_URL=https://your-gateway/v1   # optional
export MODEL_ID=anthropic/claude-sonnet-4-6      # optional

# Smoke test against the bundled six-language fixture (no network, no
# language toolchains needed — fixture has no hidden tests).
npx nexus-eval-aider-polyglot --source fixture

# Real run against the upstream Aider-AI/aider main branch (v0.2:
# fetches via GitHub Trees API, caches to ~/.nexus-eval-aider-polyglot/).
# Requires the language toolchains (pytest / npm / go / cargo / make)
# in PATH for true test-based pass/fail.
npx nexus-eval-aider-polyglot --source github --limit 10

# Pin a specific upstream commit / tag for reproducibility
npx nexus-eval-aider-polyglot --source github:abc1234 --limit 10

# Run against a local Aider-AI/aider checkout
npx nexus-eval-aider-polyglot --source /path/to/aider/benchmark/exercises --limit 10

# Filter to Rust + Go only
npx nexus-eval-aider-polyglot --source github --languages rust,go --limit 5

# Skip the test runner (fast smoke without language toolchains installed)
npx nexus-eval-aider-polyglot --source github --no-run-tests --limit 5

# JSON summary for piping
npx nexus-eval-aider-polyglot --json --source fixture > run.json
```

## Library usage

```ts
import { runBenchmark, createOpenAIAdapter } from 'nexus-agents';
import { AiderPolyglotAdapter } from 'nexus-eval-aider-polyglot';

const modelAdapter = createOpenAIAdapter({
  apiKey: process.env.OPENAI_API_KEY!,
  modelId: 'gpt-4o',
});

const adapter = new AiderPolyglotAdapter(modelAdapter, { source: 'fixture' });
const summary = await runBenchmark(adapter, {}, { concurrency: 4 });

console.log(
  `Produced edits for ${summary.passed}/${summary.total} ` +
    `(${(summary.passRate * 100).toFixed(1)}%)`
);

const meta = summary.metadata as {
  byLanguage: Record<string, { total: number; passed: number; passRate: number }>;
};
for (const [lang, stats] of Object.entries(meta.byLanguage)) {
  console.log(`  ${lang}: ${stats.passed}/${stats.total} (${(stats.passRate * 100).toFixed(1)}%)`);
}
```

Operators with their own `IModelAdapter` (Claude API, Ollama, anything implementing the contract) can substitute it for `createOpenAIAdapter` without changing anything else.

## What v0.2 actually does

**Loader (3 sources):**

- `--source fixture` — bundled six-language smoke set (~3 KB), no network
- `--source github[:<ref>]` — pulls exercises from `Aider-AI/aider` via the GitHub Trees API + `raw.githubusercontent.com`. Caches to `~/.nexus-eval-aider-polyglot/cache/<repo>/<ref>/<lang>.index.json` (second run skips network entirely). `<ref>` pins a branch / tag / commit SHA for reproducibility. Set `GITHUB_TOKEN` env var if you hit the 60/hr anonymous rate limit
- `--source <local-path>` — walks a local `Aider-AI/aider/benchmark/exercises/` checkout

**Routing test files:** the loader splits each exercise's files into `editableFiles` (shown to the model) and `hiddenTests` (not shown — used only at evaluation time). Per-language patterns: `_test.py` / `test_*.py` for Python, `*_test.go` for Go, `tests/` for Rust, `_test.cpp` / `tests/` for C++, `.test.js` / `.spec.js` / `.test.ts` / `.spec.ts` for JS/TS.

**Prompt:** whole-file edit format. Model emits fenced ``` ```<lang> path=<relative-path>``` ``` blocks. Hallucinated paths (not in `editableFiles`) are dropped at parse time.

**Evaluation (v0.2 default):** materialises the editable files + the model's edits + the hidden tests into a tmpdir, then spawns the language toolchain:

| Language   | Toolchain                                |
| ---------- | ---------------------------------------- |
| python     | `pytest -q --no-header -x`               |
| javascript | `npm test --silent`                      |
| typescript | `npm test --silent`                      |
| go         | `go test ./...`                          |
| rust       | `cargo test --quiet -- --test-threads=1` |
| cpp        | `make test`                              |

Pass = exit 0 within timeout. Sandboxing: tmpdir, `spawn` (no shell), 60s default per-instance timeout via `setTimeout` + `SIGKILL`, env scrubbed of secrets (`OPENAI_*`, `NEXUS_*`, `GITHUB_TOKEN`, `NPM_TOKEN`, `AWS_*`, ...), output capped at 4 KB per stream, refuses paths with parent-directory traversal.

Per-language pass-rate breakdown surfaces in the summary metadata.

## What v0.2 does NOT do

- Multi-turn agentic flows — model sees a static prompt, emits edits, harness evaluates. v0.3 will plug `ICliAdapter` in for iterate-on-test-failures.
- Per-language Docker sandbox — current process-level sandboxing assumes vetted Aider-AI/aider exercises. Per-language Docker would be the next escalation if the threat model expands.

## Roadmap

| Issue | Scope                                                                                                          |
| ----- | -------------------------------------------------------------------------------------------------------------- |
| TBD   | **v0.3 — Multi-turn agentic flow** via `ICliAdapter` so the model can iterate on test failures across turns.   |
| TBD   | **v0.3 — Docker per-language sandbox** if the threat model expands beyond vetted upstream exercises.            |

Cross-repo tracking lives at [nexus-agents #2519](https://github.com/williamzujkowski/nexus-agents/issues/2519) (Tier 1 prioritisation pass).

## The contract

`BenchmarkAdapter` from nexus-agents:

```ts
interface BenchmarkAdapter<TInstance, TPrediction, TEvalResult> {
  readonly name: string;
  readonly variant?: string;
  loadInstances(config): Promise<readonly TInstance[]>;
  runInstance(instance, ctx): Promise<TPrediction>;
  evaluate(instance, prediction): Promise<TEvalResult>;
  isPass(result): boolean;
  summarize(results, runTimeMs): BenchmarkRunSummary;
}
```

The orchestrator (`runBenchmark` in nexus-agents) handles concurrency, timeouts, progress, and partial failure — this repo doesn't reimplement the harness.

## License

MIT.
