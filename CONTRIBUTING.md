# Contributing to Distill Anything

Contributions are welcome. This guide covers local setup, testing expectations, and how to extend the pipeline.

## Prerequisites

- [Bun](https://bun.sh) >= 1.2.0
- Git
- A configured model provider for live end-to-end runs (such as Codex CLI, or an API key for Anthropic, OpenAI, or Google). Unit tests run offline with deterministic fixtures and do not require an API key.

## Local Setup

```bash
git clone https://github.com/imMamdouhaboammar/repo-to-skill.git
cd repo-to-skill
bun install
bun run check
```

`bun run check` runs `bunx tsc --noEmit` followed by `bun test`.

## Branching and Pull Requests

1. Fork the repository and create a branch from `main`.
2. Keep changes focused on a single concern.
3. Ensure `bun run check` passes with zero errors.
4. Any change to `prompts/` or pipeline stages (`src/stages/`) must include regression tests in `tests/unit/` covering the new or fixed behavior.
5. Never commit hardcoded local paths, `.env` files, or credentials.
6. Open a pull request describing what changed, why, and how it was verified.

## Adding a Tree-Sitter WASM Grammar

`distill-anything` uses `web-tree-sitter` WASM grammars in `grammars/` for Stage 2 AST import-graph extraction (`src/stages/02-signals/ast-graph.ts`). To add a new language:

1. Obtain the compiled `tree-sitter-<lang>.wasm` binary compatible with `web-tree-sitter` (`0.20.8`) and place it in `grammars/`.
2. Register the language extension mapping and `LANG_TO_WASM` entry in `src/stages/02-signals/ast-graph.ts` and `src/stages/01-ingest.ts`.
3. Add import-extraction queries for the language in `src/stages/02-signals/ast-graph.ts` and code-fence mapping in `src/stages/05-compiler/render-pattern.ts`.
4. Add unit tests in `tests/unit/` verifying import resolution and fan-in scoring on sample files for the new language.
