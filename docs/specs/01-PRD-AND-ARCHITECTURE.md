# 01 — Product Requirements & System Architecture (`distill`)

## 1. Overview
`distill` is a standalone CLI tool built with Bun and TypeScript that analyzes an open-source or research repository and compiles its transferable engineering decisions into a progressive-disclosure Agent Skill (`SKILL.md` + `references/patterns/*.md`).

The tool targets architectural patterns, concurrency strategies, memory layouts, error-boundary designs, type-safety invariants, and performance trade-offs verified directly against source code and git history.

## 2. Scope & Non-Goals

### In Scope
- Analyzing local git repositories or remote GitHub/GitLab URLs.
- Supporting monorepos via explicit `--subpath` targeting.
- Deterministic static analysis (AST + dependency fan-in + git diff mining) prior to any LLM call.
- Multi-stage LLM extraction with strict Zod schema validation and verbatim source-line grounding.
- Automated Novelty Gate that drops generic patterns already known to frontier LLMs.
- Exporting standard Agent Skills compatible with Claude Code (`.claude/skills/`), Cursor (`.cursor/skills/`), and Codex (`.agents/skills/`).
- Hard USD budget enforcement across all API calls.

### Non-Goals
- Generating API reference docs or CLI usage guides for calling the target repository as a dependency.
- Modifying, refactoring, or opening PRs against the target repository.
- Executing untrusted code or running test suites inside the target repository (static analysis only).
- Supporting non-git archives without a commit history (degraded mode allowed with `--no-git`, warning emitted).

## 3. Target Tech Stack
- **Runtime & Bundler**: Bun `>= 1.2.0` (`bun build --compile` for single-binary distribution).
- **Language**: TypeScript `>= 5.7` (`strict: true`, `noUncheckedIndexedAccess: true`).
- **CLI Parsing**: `commander` or `citty`.
- **Schema & Validation**: `zod` `^3.24` + `zod-to-json-schema`.
- **AST Parsing**: `web-tree-sitter` with pre-bundled WASM grammars (`typescript`, `tsx`, `python`, `rust`, `go`, `cpp`).
- **File Discovery**: `fast-glob` + `ignore` (respects `.gitignore` and `.distillignore`).
- **LLM Client**: Vercel AI SDK (`ai`, `@ai-sdk/anthropic`, `@ai-sdk/openai`, `@ai-sdk/google`) for unified structured outputs and token accounting.
- **Token Counting**: `js-tiktoken` (cl100k_base approximation for deterministic budget gating).

## 4. Pipeline Architecture

```
[Target Repo URL / Local Path]
              │
              ▼
┌─────────────────────────────────────────┐
│ Stage 1: Ingest & Repo Profiler         │  (Deterministic + Git)
│ - Shallow clone (--depth 150)           │
│ - Language detection & maturity signals │
│ - Noise/vendor/generated exclusion      │
└─────────────────┬───────────────────────┘
                  │ RepoProfile
                  ▼
┌─────────────────────────────────────────┐
│ Stage 2: Deterministic Signal Extractor │  (Deterministic + WASM AST)
│ - Import graph & Fan-in centrality      │
│ - Edge-case test file ranking           │
│ - High-signal Git commit diff mining    │
│ - Token-capped SignalBundle assembly    │
└─────────────────┬───────────────────────┘
                  │ SignalBundle (<= 60k tokens)
                  ▼
┌─────────────────────────────────────────┐
│ Stage 3: Evidence-Based Pattern Miner   │  (LLM — High Reasoning Model)
│ - Structured JSON extraction            │
│ - Strict Seen vs Inferred tagging       │
│ - Deterministic Snippet Grounder        │  (Verifies file + lines exist)
└─────────────────┬───────────────────────┘
                  │ CandidatePattern[]
                  ▼
┌─────────────────────────────────────────┐
│ Stage 4: Novelty & Anti-Fluff Gate      │  (LLM — Parallel Blind Test)
│ - Blind baseline solution generation    │
│ - Head-to-head judge rubric (1–5)       │
│ - Drop score < 4 or missing anti-trigger│
└─────────────────┬───────────────────────┘
                  │ VerifiedPattern[]
                  ▼
┌─────────────────────────────────────────┐
│ Stage 5: Skill Compiler & Verifier      │  (Deterministic)
│ - Emit SKILL.md (<= 1,200 tokens)       │
│ - Emit references/patterns/*.md         │
│ - Emit distill-report.json              │
└─────────────────────────────────────────┘
```

## 5. Repository Directory Structure

```text
distill/
├── package.json
├── tsconfig.json
├── bin/
│   └── distill.ts                  # CLI entrypoint
├── grammars/                       # Bundled tree-sitter .wasm files
│   ├── tree-sitter-typescript.wasm
│   ├── tree-sitter-python.wasm
│   ├── tree-sitter-rust.wasm
│   ├── tree-sitter-go.wasm
│   └── tree-sitter-cpp.wasm
├── prompts/                        # Externalized prompt templates (.md)
│   ├── miner-system.md
│   ├── miner-user.md
│   ├── novelty-baseline.md
│   └── novelty-judge.md
├── src/
│   ├── cli/
│   │   ├── args.ts                 # Flag definitions & validation
│   │   └── reporter.ts             # Terminal progress & cost display
│   ├── core/
│   │   ├── budget.ts               # Real-time USD & token ledger
│   │   ├── llm.ts                  # Provider wrapper, retries, structured output
│   │   └── tokens.ts               # Token counting & truncation helpers
│   ├── schemas/
│   │   ├── repo-profile.ts
│   │   ├── signal-bundle.ts
│   │   ├── pattern.ts
│   │   ├── novelty.ts
│   │   └── report.ts
│   ├── stages/
│   │   ├── 01-ingest.ts
│   │   ├── 02-signals/
│   │   │   ├── ast-graph.ts
│   │   │   ├── git-miner.ts
│   │   │   ├── test-hunter.ts
│   │   │   └── bundler.ts
│   │   ├── 03-miner/
│   │   │   ├── extract.ts
│   │   │   └── grounder.ts         # Deterministic line & snippet verification
│   │   ├── 04-novelty/
│   │   │   ├── baseline.ts
│   │   │   └── judge.ts
│   │   └── 05-compiler/
│   │       ├── render-skill.ts
│   │       └── render-pattern.ts
│   └── eval/
│       └── harness.ts              # A/B evaluation runner
└── tests/
    ├── fixtures/
    └── unit/
```

## 6. CLI Contract

### Primary Command

```bash
distill <source> [options]
```

### Arguments & Flags

| Flag | Type | Default | Description |
| --- | --- | --- | --- |
| `<source>` | `string` | Required | Local path or Git URL (`https://...` or `git@...`). |
| `--out <dir>` | `string` | `./.claude/skills` | Output directory where `<skill-slug>/` will be written. |
| `--name <slug>` | `string` | Auto-derived | Override output skill folder name (kebab-case). |
| `--subpath <path>` | `string` | `.` | Restrict analysis to a package inside a monorepo. |
| `--model <id>` | `string` | `anthropic:claude-sonnet-4-5` | Primary model for Stage 3 Pattern Mining. |
| `--judge-model <id>` | `string` | `openai:gpt-4.1-mini` | Model for Stage 4 blind baseline and judging. |
| `--max-budget <usd>` | `number` | `2.00` | Hard USD cap. Aborts gracefully before exceeding budget. |
| `--max-files <n>` | `number` | `20` | Maximum source files included in `SignalBundle`. |
| `--max-commits <n>` | `number` | `15` | Maximum high-signal git diffs included in `SignalBundle`. |
| `--git-depth <n>` | `number` | `150` | Shallow clone depth for remote repositories. |
| `--skip-novelty` | `boolean` | `false` | Bypass Stage 4 (allowed only for debugging; marks output unverified). |
| `--dry-run` | `boolean` | `false` | Run Stages 1 & 2 only; print `SignalBundle` stats and estimated USD cost. |
| `--no-git` | `boolean` | `false` | Skip git history mining for repositories without commit logs. |
| `--json` | `boolean` | `false` | Emit machine-readable report to stdout. |

### Exit Codes

* `0`: Success. Skill compiled and verified.
* `1`: General runtime or unexpected I/O error.
* `2`: Invalid CLI arguments or missing API key.
* `3`: Budget cap (`--max-budget`) reached before completion.
* `4`: Zero patterns survived the Novelty Gate (repo yielded no transferable non-obvious patterns).
* `5`: Grounding failure (LLM repeatedly produced unverified file paths or line ranges).
