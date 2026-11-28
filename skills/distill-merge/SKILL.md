---
name: distill-merge
description: Synthesize two or more distilled Agent Skills into one unified cross-repo playbook using `distill-anything merge` or `distill_merge`. Use when asked to merge skills, combine playbooks, or deduplicate patterns across repositories.
---

# Distill Merge

Combine multiple distilled skill directories into one unified, deduplicated playbook while preserving verbatim disk citations and divergent conflict branches.

## When to Use
- Consolidating skills distilled from related repositories (e.g. multiple microservices or competing implementations).
- Auto-discovering all skills inside a parent directory and synthesizing up to 15 unified patterns.

## Execution

Prefer the `distill_merge` MCP tool, or run via CLI:

```bash
distill-anything merge <skill-dir-1> <skill-dir-2> \
  --name <unified-slug> \
  --out ./.claude/skills \
  --max-patterns 12 \
  --json
```

Or pass a single parent directory containing multiple skill subdirectories:

```bash
distill-anything merge ./.claude/skills --name <unified-slug>
```

## Invariants
- `--name <slug>` (kebab-case) is required.
- At least 2 valid skill directories are required.
- `--max-patterns` is capped at `15` (default `12`).
- Verbatim code snippets are re-attached deterministically without LLM mutation, and compiled output obeys `SKILL.md <= 1,200` tokens and pattern files `<= 900` tokens.
