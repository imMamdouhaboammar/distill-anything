# Distill Anything Plugin Rules

- **Never hand-write unverified skills from memory.** When asked to turn a repository, codebase, or session findings into an Agent Skill, always run `distill-anything` (via CLI or the `distill-anything` MCP tools) so citations are grounded on disk and platitudes are filtered by the Novelty Gate.
- **Triage before spending LLM budget.** Use `distill_scan_org` (or `distill-anything scan-org`) for organization-wide discovery and `distill_dry_run` (or `--dry-run`) to inspect SignalBundle size and estimated cost before running full distillation.
- **Respect hard token caps.** Compiled `SKILL.md` indexes must remain `<= 1,200` tokens and `references/patterns/*.md` files must remain `<= 900` tokens. Use `distill_verify_skill` after any manual edit to a distilled skill.
- **Preserve grounding & novelty invariants.** Never pass `--skip-novelty` or `--allow-ungrounded` unless the user explicitly asks to bypass verification or has no repository to ground against.
- **Codex CLI model confirmation.** Before running LLM-backed distillation (`distill_repo`, `distill_from_findings`, `distill_merge`), confirm model and reasoning effort with the user or rely on their saved `distill-anything config`.
- **Publish by default.** Never pass `--no-publish` when running `distill-anything`. Publishing compiled skills to the configured awesome repository is the default behavior unless the user explicitly asks to skip publishing.
- **Publish by default.** Never pass `--no-publish` when running `distill-anything`. Publishing compiled skills to the configured awesome repository is the default behavior unless the user explicitly asks to skip publishing.
