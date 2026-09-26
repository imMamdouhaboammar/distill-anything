# Universal Portable Adapter

**Portability status:** `SUPPORTED_TESTED`

The universal adapter is plain markdown with no host-specific assumptions.
Use this when the target host is unknown or when distributing to multiple hosts.

---

## What "Universal" Means

This adapter:
- Uses only standard markdown formatting
- Makes no assumptions about tool names, file paths, or CLI commands
- Requires only that the host agent can read a text file
- Works as a standalone human-readable document

---

## Universal Rule Injection Format

To inject constitution rules into any agent host, use this template:

```markdown
# Engineering Constitution Rules — {Project Name}

These rules apply to all code generated for this project.
They were extracted from the existing codebase by the `codebase-constitution` skill.

---

## CRITICAL: Architecture Boundaries

{for each CONST-ARCH-* rule with severity=critical:}
→ {rule.assertion}
   Why: {rule.rationale}

---

## CRITICAL: Security Rules

{for each CONST-SEC-* rule with severity=critical:}
→ {rule.assertion}
   Why: {rule.rationale}

---

## High Priority Rules

{for each rule with severity=high, all categories:}
→ [{rule.id}] {rule.agent_instruction}

---

## Standard Conventions

{for each rule with severity=medium:}
- [{rule.id}] {rule.assertion}

---

## Reference

Full engineering constitution: docs/CONSTITUTION.md
Machine-readable rules: docs/agent-rules.yaml
Architecture decision record: docs/adr/
```

---

## Portability Checklist

When using the universal adapter, verify:

- [ ] No absolute file paths from the source environment
- [ ] No host-specific tool names (no `view_file`, `Bash`, `Read`, etc.)
- [ ] No environment variable assumptions
- [ ] No API key requirements
- [ ] Rules expressed as positive assertions, not platform-specific actions
- [ ] File references use relative paths from repo root

---

## Distribution Format

The universal adapter packages as a simple directory:

```
codebase-constitution-output/
  CONSTITUTION.md
  docs/
    agent-rules.yaml
    capability-matrix.yaml
    adr/
      ADR-001.md
      ADR-002.md
      ...
  README.md              ← quick start guide
```

### README.md Template

```markdown
# Engineering Constitution — {Project Name}

This directory contains the engineering constitution extracted from the {Project Name} codebase.

## Files

| File | Purpose |
|---|---|
| `CONSTITUTION.md` | Full engineering constitution |
| `docs/agent-rules.yaml` | Machine-readable rules for AI coding agents |
| `docs/capability-matrix.yaml` | Technology version contracts |
| `docs/adr/` | Architecture decision records |

## Using with AI Agents

### Antigravity
Paste rules from agent-rules.yaml into your workspace rules file.

### Claude Code
Add rules to CLAUDE.md in your repository root.

### Codex
Add rules to AGENTS.md in your repository root.

### Cursor
Add rules as .mdc files in .cursor/rules/.

### Any other agent
Paste the relevant sections from CONSTITUTION.md Section 8 into your agent's instructions.

## Updating This Constitution

Run the `codebase-constitution` skill again after major refactors:
> "Re-run the codebase constitution skill on this repo"
```

---

## Capability Contract

| Capability | Status | Notes |
|---|---|---|
| Plain text read | ✅ Universal | Any agent can read markdown |
| YAML parsing | ✅ Universal | Any modern runtime |
| File write | ✅ Assumed | Target host must support file creation |
| Shell access | ❌ Not required | Universal format needs none |
| Special tools | ❌ Not required | No host-specific tools needed |

---

## Verified Support

The universal adapter is marked `SUPPORTED_TESTED` because:
- Plain markdown requires no host-specific features
- The output format has been manually verified to render on all target hosts
- No assumptions about tool availability, runtime, or permissions
