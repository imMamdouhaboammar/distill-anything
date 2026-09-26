# Codex Host Adapter

**Portability status:** `SUPPORTED_STRUCTURAL_ONLY`

Adapter for loading the Codebase Constitution into **OpenAI Codex** via `AGENTS.md` and `.codex/instructions.md`.

---

## Installation Layout

```
{repo-root}/
  AGENTS.md                         ← primary Codex project memory
  .codex/
    instructions.md                 ← alternative/supplemental
  docs/
    CONSTITUTION.md
    agent-rules.yaml
    adr/
      ADR-*.md
```

## Injection Format — AGENTS.md

```markdown
# Project Engineering Constitution

Instructions for AI coding agents working in this repository.

## Core Rules

These rules were extracted from the existing codebase. Follow all of them
when generating, editing, or reviewing code.

### Architecture Rules
{for each CONST-ARCH-* rule:}
- **[{id}]** {agent_instruction}

### Security Rules
{for each CONST-SEC-* rule:}
- **[{id}]** {agent_instruction}

### Conventions
{for each CONST-CONV-* + CONST-NAME-* rule:}
- **[{id}]** {agent_instruction}

### Testing
{for each CONST-TEST-* rule:}
- **[{id}]** {agent_instruction}

### API Design
{for each CONST-API-* rule:}
- **[{id}]** {agent_instruction}

### Data
{for each CONST-DATA-* rule:}
- **[{id}]** {agent_instruction}

## Reference Documents
- Architecture: [docs/CONSTITUTION.md](./docs/CONSTITUTION.md)
- Machine rules: [docs/agent-rules.yaml](./docs/agent-rules.yaml)
- Decision log: [docs/adr/](./docs/adr/)
```

## Loading Mechanism

Codex reads:
1. `AGENTS.md` at repository root — auto-loaded in all sessions
2. `AGENTS.md` in any parent directory up to `~` — hierarchical
3. `.codex/instructions.md` — session supplement (if supported)

## Capability Contract

| Capability | Status | Notes |
|---|---|---|
| File read | ✅ Available | Native file access |
| File write | ✅ Available | Native file write |
| Shell exec | ✅ Available | Terminal access |
| Subagents | ❌ No subagent syntax | Sequential only |
| Web search | ❌ Not available | Offline environment |
| Python | ✅ Available | Terminal |
| AGENTS.md loading | ✅ Available | Auto-loaded |

## Gaps

- Codex runs in an isolated environment — no live web access
- Constitution data must be fully embedded, no external URL references
- Keep AGENTS.md under ~4000 tokens for reliable loading
- Complex diagrams or tables may be truncated — use bullet lists instead
