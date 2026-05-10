#!/usr/bin/env node
/**
 * Aider polyglot evaluation CLI.
 *
 * Usage:
 *   nexus-eval-aider-polyglot [run] [options]
 *   nexus-eval-aider-polyglot --version
 *   nexus-eval-aider-polyglot --help
 *
 * Constructs an OpenAI-compatible IModelAdapter from env vars
 * (OPENAI_API_KEY, optional OPENAI_BASE_URL, MODEL_ID). Operators
 * who need a different adapter shape can compose AiderPolyglotAdapter
 * directly via the library API.
 *
 * @module cli
 */

import { parseArgs } from 'node:util';
import { runBenchmark, createOpenAIAdapter } from 'nexus-agents';
import { AiderPolyglotAdapter } from './adapter.js';
import type { PolyglotLanguage } from './types.js';

const VALID_LANGUAGES: readonly PolyglotLanguage[] = [
  'python',
  'javascript',
  'typescript',
  'go',
  'rust',
  'cpp',
];

const HELP = `nexus-eval-aider-polyglot — Aider polyglot evaluation harness

Usage:
  nexus-eval-aider-polyglot [run] [options]
  nexus-eval-aider-polyglot --version
  nexus-eval-aider-polyglot --help

Options:
  --model-id <id>             Model identifier passed to the OpenAI-compat
                              endpoint. Default: env MODEL_ID or 'gpt-4o'.
  --source <fixture|github|github:<ref>|path>
                              Where to load exercises from. Default: fixture.
                              'fixture' loads the bundled six-language smoke
                              set; 'github' fetches from Aider-AI/aider main
                              with on-disk cache (set GITHUB_TOKEN if you
                              hit anonymous rate limits); 'github:<ref>'
                              pins a branch / tag / commit SHA; <path> points
                              at a local Aider-AI/aider/benchmark/exercises
                              checkout.
  --languages <comma-list>    Filter by language (python,javascript,
                              typescript,go,rust,cpp). Default: all.
  --limit <n>                 Limit instances. Default: all.
  --concurrency <n>           Max parallel solver calls. Default: 1.
  --timeout <ms>              Per-instance timeout. Default: 300000.
  --json                      JSON summary instead of human text.
  --help, -h                  Show this help.
  --version, -v               Show version.

Environment:
  OPENAI_API_KEY      (required) auth for the OpenAI-compat endpoint.
  OPENAI_BASE_URL     (optional) override base URL.
  MODEL_ID            (optional) default model — overridden by --model-id.

Notes:
  v0.1 is a model-only baseline — sends each exercise's problem statement
  + starter content to the model and parses fenced \`\`\`<lang> path=X\`\`\`
  blocks out of the response. Pass/fail reflects "did the model produce
  any non-empty edits", NOT test-based resolution. v0.3 follow-up adds
  the language-toolchain test loop.
`;

function parseLanguages(input: string | undefined): PolyglotLanguage[] | undefined {
  if (input === undefined || input === '') return undefined;
  const parts = input.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  for (const p of parts) {
    if (!VALID_LANGUAGES.includes(p as PolyglotLanguage)) {
      throw new Error(
        `Invalid --languages value '${p}'. Must be one of: ${VALID_LANGUAGES.join(', ')}`
      );
    }
  }
  return parts as PolyglotLanguage[];
}

async function main(argv: readonly string[]): Promise<number> {
  const args = argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(HELP);
    return 0;
  }
  if (args.includes('--version') || args.includes('-v')) {
    process.stdout.write('nexus-eval-aider-polyglot 0.2.0\n');
    return 0;
  }

  const parsed = parseArgs({
    args: args[0] === 'run' ? args.slice(1) : args,
    options: {
      'model-id': { type: 'string' },
      source: { type: 'string' },
      languages: { type: 'string' },
      'no-run-tests': { type: 'boolean', default: false },
      'test-timeout': { type: 'string' },
      limit: { type: 'string' },
      concurrency: { type: 'string', default: '1' },
      timeout: { type: 'string', default: '300000' },
      json: { type: 'boolean', default: false },
    },
    allowPositionals: true,
    strict: true,
  });

  const apiKey = process.env['OPENAI_API_KEY']?.trim();
  if (apiKey === undefined || apiKey === '') {
    process.stderr.write(
      'Error: OPENAI_API_KEY is not set. Set it to the auth token for your\n' +
        'OpenAI-compat endpoint (real OpenAI, a workspace proxy, vLLM, etc.).\n'
    );
    return 2;
  }

  const modelId =
    parsed.values['model-id'] ?? process.env['MODEL_ID'] ?? 'gpt-4o';
  const baseUrl = process.env['OPENAI_BASE_URL'];
  const limit =
    parsed.values.limit !== undefined ? Number(parsed.values.limit) : undefined;
  const concurrency = Number(parsed.values.concurrency ?? '1');
  const timeoutMs = Number(parsed.values.timeout ?? '300000');
  const languages = parseLanguages(parsed.values.languages);

  const modelAdapter = createOpenAIAdapter({
    apiKey,
    modelId,
    ...(baseUrl !== undefined && baseUrl !== '' && { baseUrl }),
  });

  const adapter = new AiderPolyglotAdapter(modelAdapter, {
    ...(parsed.values.source !== undefined && { source: parsed.values.source }),
    ...(languages !== undefined && { languages }),
    ...(parsed.values['no-run-tests'] === true && { runTests: false }),
    ...(parsed.values['test-timeout'] !== undefined && {
      testTimeoutMs: Number(parsed.values['test-timeout']),
    }),
  });

  const summary = await runBenchmark(adapter, {}, {
    concurrency,
    instanceTimeoutMs: timeoutMs,
    ...(limit !== undefined ? { limit } : {}),
    onProgress: (done: number, total: number): void => {
      if (!parsed.values.json) {
        process.stderr.write(`[${String(done)}/${String(total)}]\r`);
      }
    },
  });

  if (parsed.values.json) {
    process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
  } else {
    process.stdout.write('\n');
    process.stdout.write(`${adapter.name} (model=${modelId})\n`);
    process.stdout.write(
      `  produced:   ${String(summary.passed)} / ${String(summary.total)} non-empty edits\n`
    );
    process.stdout.write(`  rate:       ${(summary.passRate * 100).toFixed(1)}%\n`);
    process.stdout.write(`  runtime:    ${(summary.runTimeMs / 1000).toFixed(1)}s\n`);
    const meta = summary.metadata as {
      byLanguage?: Record<string, { total: number; passed: number; passRate: number }>;
    };
    if (meta.byLanguage !== undefined) {
      process.stdout.write('  by language:\n');
      for (const [lang, stats] of Object.entries(meta.byLanguage)) {
        process.stdout.write(
          `    ${lang.padEnd(11)}  ${String(stats.passed)}/${String(stats.total)} ` +
            `(${(stats.passRate * 100).toFixed(1)}%)\n`
        );
      }
    }
  }

  return summary.passed === summary.total ? 0 : 1;
}

main(process.argv)
  .then((code) => {
    process.exit(code);
  })
  .catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Fatal: ${msg}\n`);
    process.exit(2);
  });
