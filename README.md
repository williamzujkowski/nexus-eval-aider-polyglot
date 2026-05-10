# nexus-eval-template

Scaffold for building a new nexus-agents evaluation / benchmark harness.

Copy this repo, implement the adapter methods against your benchmark, publish as `nexus-eval-<name>`. Any benchmark you can express as `load instances → produce prediction → evaluate verdict` fits.

## What you get

- `src/adapter.ts` — `BenchmarkAdapter` stub with all 4 required methods and inline "replace this" comments
- `src/cli.ts` — CLI entry point that invokes `runBenchmark()` from nexus-agents
- `src/index.ts` — library export so your adapter can be composed by other tools
- `src/adapter.test.ts` — smoke tests proving the scaffold runs
- `tsconfig.json`, `package.json` — TypeScript strict, vitest, Node 22+
- MIT license, peer dependency on `nexus-agents >= 2.33.0`

## Quick start

```sh
# 1. Copy this repo
gh repo create yourname/nexus-eval-<bench> --template williamzujkowski/nexus-eval-template --public

# 2. Clone + install
gh repo clone yourname/nexus-eval-<bench>
cd nexus-eval-<bench>
npm install

# 3. Sanity check — the template tests pass out of the box
npm test
```

## The contract

Every `nexus-eval-*` package implements one interface from `nexus-agents`:

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

The orchestrator (`runBenchmark` in nexus-agents) handles concurrency, timeouts, progress, and partial failure for you — you don't reimplement the harness.

## Implementation steps

1. **Rename** `nexus-eval-BENCHMARK` to your benchmark name in `package.json` (name, bin, description).
2. **Replace `BenchmarkInstance` / `BenchmarkPrediction` / `BenchmarkEvalResult`** in `src/adapter.ts` with your benchmark's actual shapes.
3. **Implement `loadInstances`** — read your dataset from disk or fetch from an API.
4. **Implement `runInstance`** — call your solver (usually a CLI subprocess or API call).
5. **Implement `evaluate`** — run tests / diff against ground truth / grade with an LLM.
6. **Customize `summarize`** — add benchmark-specific breakdowns in `metadata` (pass-by-category, dataset version, etc.).
7. **Customize the CLI** — most of `src/cli.ts` stays the same; update flags for variant names specific to your benchmark.
8. **Tag your repo** — `gh repo edit --add-topic nexus-agents-eval` so `ECOSYSTEM.md` discovery works.

## Tips

- **No HTTP server needed.** Adapters are libraries + CLIs. nexus-agents is a peer dependency; you don't need to run its MCP server to exercise the contract.
- **Per-instance failures don't abort the run.** If one instance throws, `runBenchmark` records it in `summary.metadata.failureCount` and continues.
- **Honor `ctx.signal`** in your `runInstance` so long runs can be cancelled.
- **Put variants into `config` or the constructor**, not CLI flags passed through to every instance. Example: `new MyBenchAdapter({ variant: 'lite' })`.
- **Keep pure evaluation separate from network calls.** Makes the tests reproducible and fast.

## Why a separate repo?

The nexus-agents core stays lean — benchmark harnesses are evaluation-only code that 99% of consumers don't run. Concentrating them in dedicated `nexus-eval-*` repos lets each harness:

- Evolve on its own cadence (dataset bumps, harness rewrites, model-API churn) without forcing nexus-agents minor releases.
- Pull in its own dependency tree (Docker SDKs, dataset libs, eval-specific Python tooling) without bloating the npm-installable core.
- Be peer-tested in isolation — the BenchmarkAdapter contract at the boundary is the only API surface either side has to maintain.

This is policy, not a suggestion: nexus-agents' [`benchmark-extraction-gate`](https://github.com/williamzujkowski/nexus-agents/blob/main/.github/workflows/benchmark-extraction-gate.yml) workflow fails CI on any PR that adds files under `packages/nexus-agents/src/swe-bench/` or `packages/nexus-agents/src/benchmarks/atbench/`. If you're proposing a new benchmark, this template is the right starting point. See [nexus-agents epic #2514](https://github.com/williamzujkowski/nexus-agents/issues/2514) for the rationale.

## Existing benchmarks using this pattern

- [nexus-eval-swebench](https://github.com/williamzujkowski/nexus-eval-swebench) — SWE-bench Lite / Verified / Full (clean-room rewrite, v0.2)
- [nexus-eval-atbench](https://github.com/williamzujkowski/nexus-eval-atbench) — Atbench (agent-trajectory safety)
- [nexus-eval-swebench-pro](https://github.com/williamzujkowski/nexus-eval-swebench-pro) — SWE-bench Pro (731 multi-language instances)

## Ecosystem

See [nexus-agents ECOSYSTEM.md](https://github.com/williamzujkowski/nexus-agents/blob/main/ECOSYSTEM.md) for the full registry.

## License

MIT.
