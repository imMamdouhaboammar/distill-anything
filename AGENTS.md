# Repository Agent Instructions (`distill-anything`)

## Runtime & Package Manager
- **Bun is mandatory** (`bun >= 1.2.0`). Use `bun install`, `bun add`, `bun run`, and `bunx`. Never use `npm`, `yarn`, or `pnpm`.
- Verify changes before finishing any task with:
  ```bash
  bun run check
  ```
  (`bun run check` runs `bunx tsc --noEmit` and `bun test` sequentially.)

## Engineering Standards
- **TypeScript Strictness**: `strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`, and `noImplicitOverride: true` are enabled in `tsconfig.json`. Zero `any` types; validate all external data with Zod schemas in `src/schemas/`.
- **Externalized Prompts**: Keep all LLM prompt templates in `prompts/` and load them via `src/core/prompts.ts`. Do not inline large prompt strings in TypeScript source files.
- **Pipeline Invariants**: Never weaken or bypass the disk grounder (`src/stages/03-miner/grounder.ts`), novelty gate thresholds (`src/stages/04-novelty/judge.ts`), path-traversal checks, or hard token caps (`SKILL.md` <= 1,200 tokens, pattern files <= 900 tokens).
- **Regression Tests**: Any change to `prompts/` or `src/stages/` must be accompanied by unit tests in `tests/unit/`.

## Security & Environment Policy
- Do not print, commit, or exfiltrate `.env` or `.env.*` secrets (only `.env.example` may be committed).
- Never commit hardcoded local user paths (`/Users/...`, `/home/...`) or temporary debug outputs.
- Never bypass pre-commit or PreToolUse hooks (`--no-verify` is prohibited).
- Never run pipe-to-shell installers (`curl ... | sh`, `wget ... | bash`).

## Mechanical Governance Hooks
System and project hooks enforce these rules mechanically at `PreToolUse`, `PostToolUse`, `SessionStart`, and `Stop` boundaries:
- `gov-pipe-to-shell-guard.sh`: blocks `curl|sh`, `wget|bash`, and process-substitution remote execution.
- `gov-pkg-manager-guard.sh`: blocks `npm`/`yarn`/`npx`/`pnpm` (without `.agent-kernel/package-manager-exception.json`) and `colima`.
- `gov-destructive-git-guard.sh`: blocks `--no-verify` and catastrophic `rm -rf`; gates `git reset --hard`, `git push --force`, and `git clean -f` behind macOS human confirmation.
- `gov-secret-write-guard.sh`: blocks writing live API keys or private key blocks into tracked files.
- `gov-post-commit-truth.sh`: injects verified `git log -1` and `git status -sb` after git write commands.
- `gov-session-health.sh`: runs bounded liveness/syntax checks on all `gov-*` hooks at session start.
- `gov-stop-verification-gate.sh`: prevents unverified "tests/build passed" claims without a recent verifier run.
