# Decision Archaeology — Implicit ADR Extraction

Reference for Step 4 (Decision Archaeology) of the Codebase Constitution skill.

---

## What is Decision Archaeology?

Decision Archaeology recovers engineering decisions that were made but never formally documented. The code, comments, tests, and git history are the archaeological record.

**Rule:** Every ADR extracted must cite at least one piece of code evidence. ADRs without evidence are hypothesis-only and must be marked `status: hypothesis`.

---

## Source 1: Code Comments

Search for deliberate decision markers:

```bash
# Find decision-laden comments
grep -r "TODO\|FIXME\|HACK\|NOTE\|DECISION\|WHY\|BECAUSE\|WORKAROUND\|TEMPORARY\|DEPRECATED" \
  --include="*.ts" --include="*.py" --include="*.go" --include="*.rs" \
  -l | head -30

# Get context around HACK/DECISION markers
grep -r "HACK\|DECISION\|WHY:" --include="*.ts" --include="*.py" -A2 -B2 | head -100
```

**ADR signal strength:**
- `HACK: ...` → high signal (acknowledged shortcut with implication)
- `TODO: replace with X` → medium signal (intended future direction)
- `// We use X instead of Y because...` → very high signal (explicit rationale)
- `DEPRECATED:` → high signal (superseded approach)

---

## Source 2: Configuration Structure

Configuration files encode philosophy:

| Config signal | Decision it reveals |
|---|---|
| `strict: true` in tsconfig | TypeScript strictness chosen deliberately |
| `"noImplicitAny": true` | No escape hatches policy |
| ESLint rules (forbidden patterns) | Anti-patterns team banned |
| `.prettierrc` exists + committed | Formatting standardized (avoid style debates) |
| `"engines": {"node": ">=20"}` | Runtime version decision |
| Feature flags in config | Gradual rollout capability chosen |
| Separate staging/prod configs | Environment isolation approach |

---

## Source 3: Test Structure

High test density = high uncertainty in that domain:

```bash
# Find most-tested files (highest test-to-source ratio by directory)
# Run for each major module
find . -name '*.test.*' | sed 's/\.test\.[^.]*$//' | sort | uniq -c | sort -rn
```

**ADR signal:** If `auth/` has 40 test files but `ui/` has 5, auth is considered fragile or critical → likely an explicit decision to over-invest in auth safety.

---

## Source 4: Dead Code & Deleted Approaches

```bash
# Find unused exports (TypeScript)
# Look for: files that are never imported
grep -r "export " --include="*.ts" -l | while read f; do
  base=$(basename "$f" .ts)
  if ! grep -r "from.*$base" --include="*.ts" -l | grep -v "$f" > /dev/null; then
    echo "Possibly orphaned: $f"
  fi
done

# Git blame for large deletion commits
git log --diff-filter=D --summary | grep "delete mode" | head -20

# Recently deleted directories (may indicate abandoned approach)
git log --all --full-history -- '**/old-*' '**/legacy-*' '**/deprecated-*'
```

---

## Source 5: Migration Files

Database migrations are a decision timeline:

```bash
find . -path '*/migrations/*' -name '*.sql' -o \
       -path '*/migrations/*' -name '*.py' -o \
       -path '*/migrate/*' -name '*.go' | sort
```

Each migration tells a story:
- Column additions → new requirements added
- Column removals → old approach abandoned
- Table renames → domain concept renamed
- Index additions → performance problem discovered
- Nullable → required transitions → data quality rules evolved

---

## Source 6: Package Lock Archaeology

```bash
# Find packages that were removed (in git history)
git log --all -p package.json | grep "^[-+].*\"" | grep "^\-" | grep -v "version\|^---\|^-{3}" | head -30
```

Removed packages → technology was tried and rejected. Look for migration from:
- `jest` → `vitest`
- `webpack` → `vite` / `esbuild`
- `axios` → native `fetch`
- `moment` → `date-fns` / `dayjs`
- `lodash` → native JS
- `sequelize` → `prisma` / `drizzle`

---

## Mini-ADR Template

```markdown
# ADR-{NNN}: {Title}

**Status:** implicit | accepted | superseded | deprecated | hypothesis

**Date:** (extracted from git blame or comment date if available)

## Context

What problem existed or what trade-off was being navigated.

## Decision

What the codebase actually does (evidence-backed).

## Consequences

What the decision enables, what it constrains, what technical debt it creates.

## Evidence

- `path/to/file.ts#L42` — comment showing rationale
- `migrations/0023_rename_users.sql` — schema decision
- `package.json` — dependency choice
```

---

## ADR Numbering Convention

Start at ADR-001. Sequence by order of discovery (not by importance).

Reserve ADR-000 as an index file.

---

## Quality Check for Each ADR

Before including an ADR in the constitution:

- [ ] Has at least one concrete file path evidence
- [ ] Decision is clearly stated (not a question or observation)
- [ ] Consequences are specific, not generic ("this is fast" is not a consequence)
- [ ] Status is classified
- [ ] Does not duplicate another ADR already extracted
