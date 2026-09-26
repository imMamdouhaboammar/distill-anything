# Contributing to codebase-constitution

**Copyright (c) 2026 Mamdouh Aboammar. All rights reserved.**

This project is open source under the MIT License. Contributions that strengthen evidence gates, add host adapters, or improve extraction scripts are welcome.

---

## What to contribute

| Area | Examples |
|---|---|
| New host adapters | VS Code Copilot, OpenCode, Windsurf |
| Extraction improvements | Better ADR mining, richer convention detection |
| Script enhancements | Faster harvest, more language coverage |
| Eval bank expansion | New activation and behavior test cases |
| Bug fixes | Evidence gate failures, false-positive invariant detection |

## What not to contribute

- PRs that relax evidence requirements (every claim must have a file citation)
- PRs that add invented file paths or unverified claims to templates
- Features that require an external API key or network call just to run

## Setup

```bash
git clone https://github.com/imMamdouhaboammar/codebase-constitution
cd codebase-constitution
# No npm install needed — the skill itself has no runtime dependencies
# Scripts need Python 3 + PyYAML: pip install pyyaml
```

## Testing your change

```bash
# Validate skill frontmatter and references
python3 skills/codebase-constitution/scripts/validate_constitution.py .

# Verify scripts parse cleanly
python3 -m py_compile skills/codebase-constitution/scripts/harvest.py
python3 -m py_compile skills/codebase-constitution/scripts/extract_adrs.py
python3 -m py_compile skills/codebase-constitution/scripts/generate_rules.py
python3 -m py_compile skills/codebase-constitution/scripts/validate_constitution.py

# Verify CLI
node --check bin/cli.js
```

## Commit style

Use conventional commits:

```
feat: add VS Code Copilot host adapter
fix: handle empty migration directory in extract_adrs.py
docs: clarify MUST-WHEN invariant format in taxonomy reference
refactor: split harvest.py into separate language and build detectors
```

## Pull request checklist

- [ ] All scripts parse cleanly (`python3 -m py_compile`)
- [ ] No absolute paths in `SKILL.md` portable core
- [ ] No secrets or credentials in any file
- [ ] CI passes (validate + security + package checks)
- [ ] PR description states which evidence gate or extraction pass the change affects

## Copyright

By contributing, you agree that your contributions will be licensed under the MIT License and attributed to this repository. The copyright notice `Copyright (c) 2026 Mamdouh Aboammar` remains in all files — your name appears in the git history and PR record.
