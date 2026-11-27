# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-11-28

### Added

- **5-Stage Distillation Pipeline**:
  - Stage 1 (`01-ingest.ts`): Shallow git clone (`--depth 150`, `--filter=blob:none`), language detection, deterministic `MaturityProfile`, and noise/binary/oversized (>250KB) file exclusion.
  - Stage 2 (`02-signals/`): Polyglot AST fan-in import graph using bundled `web-tree-sitter` WASM grammars (TypeScript, TSX, JavaScript, Python, Rust, Go, C++), deterministic git-diff keyword mining with smart fallback for repositories with zero keyword matches, edge-case test hunting, and 60,000-token `SignalBundle` budgeting with rollover.
  - Stage 3 (`03-miner/`): Evidence-based pattern extraction with `seen_explicit` / `inferred_from_code` tagging, mandatory anti-triggers, and a deterministic verbatim disk grounder with sliding-window off-by-N drift correction and automatic retry on >50% grounding failure.
  - Stage 4 (`04-novelty/`): Blind-baseline novelty gate that generates a baseline solution without repository context, runs a head-to-head judge on a 1-5 rubric, enforces minimum novelty and transferability thresholds, and annotates partial baseline overlap (`3/5`).
  - Stage 5 (`05-compiler/`): Token-capped skill compiler enforcing `SKILL.md` <= 1,200 tokens, `references/patterns/*.md` <= 900 tokens each, and full provenance/cost/audit output in `distill-report.json`.
- **`from-findings` Workflow**: Structures conversation notes, debugging transcripts, or review findings into a grounded, novelty-verified skill (`--repo` for disk grounding or `--allow-ungrounded` for `ungrounded_notes`).
- **Codex CLI Integration & Multi-Provider Support**: Automatic `codex` binary discovery, `~/.codex/config.toml` defaults reading, interactive `distill-anything config` setup persisted to `~/.config/distill-anything/config.json`, and `--model` support for Anthropic, OpenAI, Google, and Vertex AI (`gcloud`).
- **Budget & Safety Controls**: Real-time `BudgetLedger` with `--max-budget` hard USD cap (exit code 3), `--dry-run` cost estimation, path-traversal guards, and standalone binary compilation via `bun build --compile`.
- **Meta-Skill**: `skills/distill-anything/SKILL.md` and `bun run install:skill` for routing agent workflows through the verified pipeline.
