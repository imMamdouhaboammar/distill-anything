# Antigravity Host Adapter

**Portability status:** `SUPPORTED_STRUCTURAL_ONLY`

Adapter for loading the Codebase Constitution into **Google Antigravity** agents as behavioral instructions.

---

## Installation Layout

Place the constitution outputs at:

```
{workspace}/
  docs/
    CONSTITUTION.md          ← human reference
    agent-rules.yaml         ← machine rules
    adr/
      ADR-*.md
  .gemini/
    config/
      rules/
        project-constitution.md   ← this adapter injects here
```

## Injection Format

Create `project-constitution.md` from the CONSTITUTION.md agent rules section:

```markdown
# Project Engineering Constitution

The following rules apply to ALL code generated for this project.
They were extracted from the existing codebase and must be followed unconditionally.

## Architecture Rules
{paste CONST-ARCH-* rules from agent-rules.yaml}

## Security Rules
{paste CONST-SEC-* rules from agent-rules.yaml}

## Convention Rules
{paste CONST-CONV-* + CONST-NAME-* rules from agent-rules.yaml}

## Testing Rules
{paste CONST-TEST-* rules from agent-rules.yaml}

## API Rules
{paste CONST-API-* rules from agent-rules.yaml}

## Data Rules
{paste CONST-DATA-* rules from agent-rules.yaml}
```

## Loading Mechanism

Antigravity loads rules from:
1. `~/.gemini/config/rules/` — global
2. `.gemini/rules/` — workspace (recommended for project constitution)

Reference this adapter when configuring workspace-level constitutional rules.

## Capability Contract

| Capability | Status | Notes |
|---|---|---|
| File read | ✅ Available | `view_file` tool |
| File write | ✅ Available | `write_to_file` tool |
| Shell exec | ✅ Available | `run_command` tool |
| Subagents | ✅ Available | `invoke_subagent` tool |
| Web search | ✅ Available | `search_web` tool |
| Python | ✅ Available | via `run_command` |
| Skill loading | ✅ Available | SKILL.md auto-discovery |

## Gaps

- Antigravity does not have a native "apply rules to all sessions" UI
- Rules must be re-injected via workspace config or user rules file
- No automated rule enforcement (agent must follow voluntarily)
