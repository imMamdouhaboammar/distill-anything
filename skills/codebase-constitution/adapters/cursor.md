# Cursor Host Adapter

**Portability status:** `SUPPORTED_STRUCTURAL_ONLY`

Adapter for loading the Codebase Constitution into **Cursor** via `.cursorrules` or `.cursor/rules/`.

---

## Installation Layout

```
{repo-root}/
  .cursorrules                      ← legacy global rules (Cursor < 0.45)
  .cursor/
    rules/
      constitution-arch.mdc         ← architecture rules
      constitution-security.mdc     ← security rules
      constitution-conventions.mdc  ← convention rules
      constitution-testing.mdc      ← testing rules
      constitution-api.mdc          ← API design rules
  docs/
    CONSTITUTION.md
    agent-rules.yaml
```

## Injection Format — `.cursor/rules/*.mdc`

Use Cursor's MDC (Markdown Cursor) format for targeted rules:

```markdown
---
description: Architecture rules extracted from the {Project Name} codebase constitution
globs: ["src/**/*.ts", "src/**/*.tsx"]
alwaysApply: false
---

# Architecture Rules — {Project Name}

{for each CONST-ARCH-* rule:}
## {id}: {assertion}

{rationale}

**Never:**
```
{violation_example.code}
```

**Always:**
```
{compliant_example.code}
```
```

### Rule File Mapping

| File | Rules | Globs |
|---|---|---|
| `constitution-arch.mdc` | CONST-ARCH-* | `src/**/*` |
| `constitution-security.mdc` | CONST-SEC-* | `src/**/*` |
| `constitution-conventions.mdc` | CONST-CONV-* + CONST-NAME-* | `**/*` |
| `constitution-testing.mdc` | CONST-TEST-* | `**/*.test.*`, `**/*.spec.*` |
| `constitution-api.mdc` | CONST-API-* | `src/**/routes/**`, `src/**/controllers/**` |
| `constitution-data.mdc` | CONST-DATA-* | `src/**/repositories/**`, `src/**/models/**` |

## Legacy `.cursorrules` Format

For Cursor versions < 0.45 or when a single file is preferred:

```
# Engineering Constitution — {Project Name}
# Generated from: docs/CONSTITUTION.md

## Architecture Rules
{paste all CONST-ARCH-* agent_instruction values, one per line}

## Security Rules (Critical)
{paste all CONST-SEC-* agent_instruction values, one per line}

## Conventions
{paste all CONST-CONV-* + CONST-NAME-* agent_instruction values}

## Testing
{paste all CONST-TEST-* agent_instruction values}

## Full Reference
See docs/CONSTITUTION.md for the complete engineering constitution.
```

## Capability Contract

| Capability | Status | Notes |
|---|---|---|
| File read | ✅ Available | Cursor native |
| File write | ✅ Available | Cursor editor |
| Shell exec | ✅ Available | Terminal panel |
| .mdc rules | ✅ Available | `.cursor/rules/` (Cursor ≥ 0.45) |
| .cursorrules | ✅ Available | Legacy format |
| Glob targeting | ✅ Available | Per-rule `globs` field |

## Gaps

- `.cursorrules` has no schema — plain text only
- MDC format rules apply to chat context, not inline completions
- Very long rule files reduce effectiveness — keep each file under 2000 tokens
- `alwaysApply: true` applies to every request — use sparingly (critical security rules only)
