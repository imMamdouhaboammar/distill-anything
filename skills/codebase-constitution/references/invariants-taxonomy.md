# Invariants Taxonomy

Reference for Step 5 (Invariant Distillation) of the Codebase Constitution skill.

---

## Definition

An **invariant** is a rule that the codebase enforces consistently — either mechanically (lint, types, CI) or by strong convention (code review norms, patterns).

An invariant differs from a **preference** (inconsistently applied) and a **suggestion** (documented but unenforced).

---

## Class Definitions

### MUST-NEVER

Absolute prohibitions. The codebase consistently avoids this pattern.

**Detection signals:**
- ESLint `"no-*"` rules
- Banned imports in `tsconfig.json` or `webpack.config.js`
- Rubocop `Enabled: false` cops
- CI job that fails on the pattern
- Security scanner rule
- Runtime guard that throws if violated

**Examples:**
```
MUST-NEVER: Use raw string interpolation in SQL queries
MUST-NEVER: Import from a sibling domain module directly
MUST-NEVER: Commit secrets or API keys
MUST-NEVER: Use `any` type without suppression comment
MUST-NEVER: Call external services without a timeout
```

### MUST-ALWAYS

Required patterns. The codebase consistently includes this.

**Detection signals:**
- Every function of type X has pattern Y
- Middleware applied globally
- Base class or interface that all entities implement
- Required fields in every request object
- Test pattern present in every service test file

**Examples:**
```
MUST-ALWAYS: Wrap external service calls in try/catch with structured error
MUST-ALWAYS: Include correlation-id in every log line
MUST-ALWAYS: Validate input at the controller boundary
MUST-ALWAYS: Use dependency injection for service instantiation
MUST-ALWAYS: Write a test for every public API endpoint
```

### MUST-WHEN

Conditional requirements. Applied only in specific contexts.

**Detection signals:**
- Feature flag checks before certain code paths
- Environment-based conditionals
- Retry logic on specific error types
- Auth guard on routes matching a pattern

**Examples:**
```
MUST-WHEN mutating state: wrap in a database transaction
MUST-WHEN calling a third-party API: implement exponential backoff
MUST-WHEN returning PII: apply field-level encryption
MUST-WHEN in production: disable debug endpoints
MUST-WHEN a queue consumer fails: publish to DLQ after N retries
```

---

## Enforcement Classification

| Level | Meaning | Examples |
|---|---|---|
| `lint` | Caught by static analysis before commit | ESLint rule, Rubocop, Clippy |
| `type` | Caught by type checker at compile time | TypeScript strict mode, mypy |
| `test` | Caught by automated tests | Test that fails on violation |
| `runtime` | Caught at runtime before damage | Guard clause, validation middleware |
| `ci` | Caught in CI before merge | Secret scanner, SAST, coverage gate |
| `convention` | Caught only in code review | Naming convention, comment style |
| `unverified` | Observed pattern, no enforcement mechanism found | |

---

## Severity Classification

| Level | Meaning |
|---|---|
| `critical` | Violation causes security breach, data loss, or system outage |
| `high` | Violation causes observable bugs or reliability failure |
| `medium` | Violation causes tech debt, inconsistency, or maintainability issues |
| `low` | Violation causes style or convention drift |

---

## Invariant YAML Schema

```yaml
invariant:
  id: INV-{NNN}
  class: MUST_NEVER | MUST_ALWAYS | MUST_WHEN
  rule: ""                         # one clear, specific sentence
  rationale: ""                    # why this rule exists
  condition: ""                    # only for MUST_WHEN: when does it apply
  evidence:
    - path: "src/auth/middleware.ts"
      line_range: "12-25"
      note: "auth guard applied to all routes"
  enforcement: lint | type | test | runtime | ci | convention | unverified
  severity: critical | high | medium | low
  source_adr: ADR-XXX              # backref if applicable
```

---

## Sampling Strategy

Do NOT try to find every invariant exhaustively. Sample:

1. **Lint/type config** (complete read — these are explicit)
2. **Top 5 most-changed files** (hotspots often have implicit guards)
3. **All middleware/hooks/interceptors** (cross-cutting enforcement)
4. **Auth-related files** (security invariants are critical)
5. **10 random service/handler files** (check for missing patterns)
6. **All test fixture/factory files** (reveals what's always true in test data)

Minimum: 5 MUST-NEVER + 5 MUST-ALWAYS + 3 MUST-WHEN
Maximum: uncapped, but stop when new invariants become redundant with existing ones

---

## Invariant Anti-patterns to Avoid

- **Generic invariants**: "Always write good code" → not an invariant
- **Aspirational invariants**: "Should use..." → not an invariant, this is a suggestion
- **Ungrounded invariants**: No evidence citation → mark as `enforcement: unverified` at minimum
- **Duplicates**: Same rule stated twice with different phrasing
