---
name: distill-anything
description: Distill repository architecture or conversation findings into a grounded, novelty-verified Agent Skill using `distill-anything` (Codex CLI default). Use when asked to "use distill-anything", "use repo-to-skill", "turn these findings into a skill", "distill this repo into a playbook", or "skillify this project".
---

# Distill Anything Meta-Skill

Convert repository code or session findings into a verified Agent Skill (`SKILL.md` + `references/patterns/*.md` + `distill-report.json`) via `distill-anything`.

**CRITICAL**: NEVER hand-write an unverified `SKILL.md` from chat memory. Always run `distill-anything` so citations are grounded on disk and platitudes are filtered.

## Path 1: From Findings in Current Session

1. Write structured findings to `/tmp/distill-findings.md` (mechanisms, trade-offs, exact file paths, verbatim snippets, repo path/URL).
2. Run `distill-anything from-findings`:
   ```bash
   distill-anything from-findings /tmp/distill-findings.md \
     --repo <local-path-or-url> \
     --out <target-project>/.claude/skills \
     --name <kebab-case-slug>
   ```
   *(Pass `--allow-ungrounded` only if no repo exists; marks output `evidence: ungrounded_notes`.)*
3. Delete `/tmp/distill-findings.md` after completion.

## Path 2: From Raw Repository

```bash
distill-anything <repo-url-or-path> \
  --out <target-project>/.claude/skills \
  --name <kebab-case-slug>
```
*(Use `.agents/skills` if the project uses `.agents/skills/`.)*

## Provider & Options

- Default provider: local **Codex CLI** (`distill-anything config` sets model & reasoning).
- `--reasoning <low|medium|high|xhigh>` / `--judge-reasoning <effort>`: Per-run overrides.
- `--min-novelty <1-5>`: Minimum novelty score (defaults: `4` repo, `3` from-findings).
- `--model <provider:model>` / `--judge-model <id>`: Override provider (e.g. `codex:gpt-5.4`, `anthropic:claude-sonnet-4-5`).

## Post-Run Report

Read `<out>/<slug>/distill-report.json` and report: `patternsKept`, `patternsDropped` (count, stage, reason/noveltyScore), `groundingFailures` (`groundingMode`), and `totalCostUsd`.
