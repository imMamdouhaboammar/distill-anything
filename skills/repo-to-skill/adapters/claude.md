# Claude Code Host Adapter

**Portability status:** `SUPPORTED_STRUCTURAL_ONLY`

Adapter for loading the Codebase Constitution into **Claude Code** via `CLAUDE.md`.

---

## Installation Layout

```
{repo-root}/
  CLAUDE.md                  ← Claude's project memory (inject rules here)
  docs/
    CONSTITUTION.md
    agent-rules.yaml
    adr/
      ADR-*.md
```

## Injection Format

Append to or create `CLAUDE.md` at the repository root:

```markdown
# Engineering Constitution — {Project Name}

> Source: docs/CONSTITUTION.md | Generated: {date}

## Rules Claude Must Follow

### Architecture
{for each CONST-ARCH-* rule: paste agent_instruction field}

### Security
{for each CONST-SEC-* rule: paste agent_instruction field}

### Conventions
{for each CONST-CONV-* + CONST-NAME-* rule: paste agent_instruction field}

### Testing
{for each CONST-TEST-* rule: paste agent_instruction field}

### API Design
{for each CONST-API-* rule: paste agent_instruction field}

### Data
{for each CONST-DATA-* rule: paste agent_instruction field}

## Full Reference
See [docs/CONSTITUTION.md](./docs/CONSTITUTION.md) for the complete engineering constitution.
See [docs/agent-rules.yaml](./docs/agent-rules.yaml) for machine-readable rules.
```

## Loading Mechanism

Claude Code reads `CLAUDE.md` at session start from:
1. Repository root (`./CLAUDE.md`) — recommended for project constitution
2. Home directory (`~/.claude/CLAUDE.md`) — global fallback

## Capability Contract

| Capability | Status | Notes |
|---|---|---|
| File read | ✅ Available | `Read`, `Glob`, `Grep` tools |
| File write | ✅ Available | `Write`, `Edit` tools |
| Shell exec | ✅ Available | `Bash` tool |
| Subagents | ✅ Available | `Task` tool |
| Web search | ❌ Not available | Unless MCP configured |
| Python | ✅ Available | via `Bash` |
| CLAUDE.md loading | ✅ Available | Auto-loaded at session start |

## Gaps

- CLAUDE.md has no schema enforcement — rules are prose-only
- No automatic validation that Claude followed the rules
- CLAUDE.md contents count against context window
- Long constitutions should be summarized, with reference to full docs/
