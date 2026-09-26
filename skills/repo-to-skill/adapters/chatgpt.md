# ChatGPT Plugin Host Adapter

**Portability status:** `SUPPORTED_STRUCTURAL_ONLY`

Adapter for packaging the Codebase Constitution as a **ChatGPT / Codex Plugin** skill.

---

## Plugin Package Layout

```
codebase-constitution-plugin/
  .codex-plugin/
    plugin.json               ← plugin manifest
  skills/
    codebase-constitution/
      SKILL.md                ← core skill (from this package)
  assets/
    constitution-template.md  ← output template
  docs/
    CONSTITUTION.md           ← (generated per-project — not in package)
```

## Plugin Manifest — `.codex-plugin/plugin.json`

```json
{
  "schema_version": "1.0",
  "name": "codebase-constitution",
  "display_name": "Codebase Constitution",
  "description": "Reverse-engineer any codebase into a living engineering constitution — capturing architecture decisions, invariants, conventions, and reusable agent rules.",
  "version": "1.0.0",
  "homepage_url": "https://github.com/yourusername/codebase-constitution",
  "contact_email": "your@email.com",
  "skills": [
    {
      "name": "codebase-constitution",
      "path": "skills/codebase-constitution/SKILL.md",
      "description": "Reverse-engineer any codebase into a reusable engineering constitution with invariants, ADRs, and agent rules."
    }
  ],
  "capabilities_required": [
    "file_read",
    "file_write",
    "shell_exec"
  ],
  "capabilities_optional": [
    "python_exec"
  ]
}
```

## Capability Contract

| Capability | Status | Notes |
|---|---|---|
| File read | ✅ Available | ChatGPT Code Interpreter (Codex) |
| File write | ✅ Available | Code Interpreter |
| Shell exec | ✅ Available | Code Interpreter terminal |
| Python | ✅ Available | Code Interpreter |
| Web search | ✅ Available | ChatGPT browsing (if enabled) |
| Subagents | ❌ Not available | Sequential only |
| Skill loading | ✅ Available | Plugin skill discovery |

## ChatGPT Session Behavior

When activated through ChatGPT:

1. The SKILL.md is loaded as a system instruction supplement
2. Scripts (harvest.py, validate_constitution.py) can be run via Code Interpreter
3. Generated files can be downloaded by the user

## Trigger Prompts for ChatGPT

Include these in the plugin listing discovery prompts:

```
"reverse engineer my codebase"
"generate a constitution from my code"
"extract architecture decisions from this repo"
"create CONSTITUTION.md for my project"
"what are the engineering invariants in this codebase?"
"extract agent rules from my codebase"
```

## Gaps

- ChatGPT Code Interpreter is sandboxed — cannot access the user's actual filesystem
- User must upload a zip of their codebase for analysis
- Git history is not available unless explicitly included in upload
- No persistent rules file on the host — constitution must be downloaded
