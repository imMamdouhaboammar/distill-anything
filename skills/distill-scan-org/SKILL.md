---
name: distill-scan-org
description: Triage and rank repositories across a GitHub organization by signal density with zero LLM cost using `distill-anything scan-org` or `distill_scan_org`. Use when asked to scan an org, find high-signal repos, or prioritize which repos to distill.
---

# Distill Scan Org

Rank repositories in any GitHub organization by craftsmanship and signal density before spending any LLM budget.

## When to Use
- Exploring a large GitHub org (`NVIDIA`, `anthropics`, `vercel-labs`, etc.) to find the highest-signal repositories.
- Filtering out forks, archived repos, or oversized monorepos before cloning.

## Execution

Prefer the `distill_scan_org` MCP tool, or run via CLI:

```bash
distill-anything scan-org <org> \
  --limit 20 \
  --min-stars 50 \
  --max-size-mb 150 \
  --concurrency 3 \
  --json
```

Optional filters:
- `--lang <language>` (e.g. `typescript`, `python`, `rust`, `cuda`, `c++`)
- `--include-forks` / `--include-archived`
- `--out <file>` to persist the ranked JSON report

## Output
Report the top-ranked repositories with their signal density score, primary language, star count, and recommended next `distill-anything <repo-url>` command.
