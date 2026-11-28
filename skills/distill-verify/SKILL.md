---
name: distill-verify
description: Verify a compiled Agent Skill directory against distill-anything invariants — SKILL.md <= 1,200 tokens, pattern files <= 900 tokens, valid distill-report.json, and optional disk grounding. Use when auditing or editing a distilled skill.
---

# Distill Verify

Audit any distilled skill directory against the deterministic `distill-anything` invariants.

## Checks Performed
1. **Hard Token Caps**:
   - `SKILL.md` <= `1,200` tokens
   - Each `references/patterns/*.md` <= `900` tokens
2. **Report Integrity**:
   - `distill-report.json` exists and parses against `DistillReportSchema`
   - Checks `groundingMode`, `patternsKept`, `patternsDropped`, `groundingFailures`, and `totalCostUsd`
3. **Optional Disk Grounding**:
   - When a `--repo` / `repoPath` is provided, verifies cited file paths stay inside `analysisRoot` (no path traversal) and exist on disk.

## Execution

Call the `distill_verify_skill` MCP tool with `skillDir` (and optional `repoPath`), or run:

```bash
bun run bin/mcp-server.ts --verify <skill-dir>
```
