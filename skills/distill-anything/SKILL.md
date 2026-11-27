---
name: distill-anything
description: Distill repository architecture, GitHub orgs, or conversation findings into a grounded, novelty-verified Agent Skill using `distill-anything` (Codex CLI default). Use when asked to "use distill-anything", "scan this org", "merge these skills", "update this skill", "turn these findings into a skill", or "distill this repo".
---

# Distill Anything Meta-Skill

Convert codebases, GitHub organizations, or session findings into verified Agent Skills (`SKILL.md` + `references/patterns/*.md` + `distill-report.json`) via `distill-anything`.

**CRITICAL**: NEVER hand-write an unverified `SKILL.md` from chat memory. Always run `distill-anything` so citations are grounded on disk and platitudes are filtered.

## Workflows

1. **From Findings in Current Session**:
   Write structured findings to `/tmp/distill-findings.md`, run:
   ```bash
   distill-anything from-findings /tmp/distill-findings.md \
     --repo <local-path-or-url> --out <target>/.claude/skills --name <slug>
   ```
   *(Use `--allow-ungrounded` only if no repo exists; delete `/tmp/distill-findings.md` afterward.)*

2. **From Raw Repository (or Incremental Update)**:
   ```bash
   distill-anything <repo-url-or-path> --out <target>/.claude/skills --name <slug>
   # Incrementally update an existing skill from git delta:
   distill-anything <repo-url-or-path> --out <target>/.claude/skills --name <slug> --update
   ```

3. **Org-Scale Radar (`scan-org`, zero LLM cost)**:
   ```bash
   distill-anything scan-org <org> --limit 20 --lang python --max-size-mb 150
   ```

4. **Cross-Repo Synthesis (`merge`)**:
   ```bash
   distill-anything merge <skill-dir-1> <skill-dir-2> --name <unified-slug> --out <target>/.claude/skills
   ```

## Provider & Post-Run Report

- Default provider: local **Codex CLI** (`distill-anything config` sets model & reasoning).
- Overrides: `--model <provider:model>`, `--reasoning <low|medium|high|xhigh>`, `--min-novelty <1-5>`.
- Read `<out>/<slug>/distill-report.json` and report `patternsKept`, `patternsDropped`, `groundingFailures`, and `totalCostUsd`.
