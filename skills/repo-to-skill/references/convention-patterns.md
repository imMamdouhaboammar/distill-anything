# Convention Patterns — Extraction Categories

Reference for Step 6 (Convention Codification) of the Codebase Constitution skill.

---

## Category 1: Naming Conventions

### Detection Method

Sample 30–50 files across the codebase. Record:

```
entity_type → naming_style → examples
```

| Entity | Styles to check |
|---|---|
| Files | `camelCase.ts` / `kebab-case.ts` / `PascalCase.ts` / `snake_case.py` |
| Classes | `PascalCase` (near-universal) |
| Interfaces | `IUserService` vs `UserService` vs `UserServiceInterface` |
| Types | `UserDTO` / `UserDto` / `UserType` / `User` |
| Functions | `camelCase` / `snake_case` / `PascalCase` |
| Constants | `SCREAMING_SNAKE` / `camelCase` / `PascalCase` |
| React components | `PascalCase.tsx` / colocated vs `components/` |
| Database tables | `snake_case` / `PascalCase` / `camelCase` |
| API endpoints | `/resource` / `/resource-name` / `/resourceName` |
| Test files | `*.test.ts` / `*.spec.ts` / `test_*.py` / `*_test.go` |

**Convention strength:**
- **canonical**: > 90% of instances follow the pattern
- **majority**: 60–90%
- **observed**: < 60% — note as inconsistency, not convention

---

## Category 2: File Structure Conventions

Record the **module structure template**:

```
Does each feature get:
  - One file per entity? (flat)
  - A directory? (feature folders)
  - A domain package? (domain-driven)

Where do tests live?
  - Co-located: src/users/users.service.test.ts
  - Separate: tests/users/users.service.test.ts
  - Root: __tests__/users.service.test.ts

Are barrel files (index.ts) used?
  - Universal (every module exports through index)
  - Some (only for public API)
  - None
```

---

## Category 3: Error Handling Conventions

Look for the **primary error handling pattern**:

```typescript
// Pattern A: Exceptions with typed Error classes
class UserNotFoundError extends AppError { ... }
throw new UserNotFoundError(id)

// Pattern B: Result type
type Result<T, E> = { ok: true; value: T } | { ok: false; error: E }
return { ok: false, error: 'USER_NOT_FOUND' }

// Pattern C: Go-style tuple returns
const [data, err] = await fetchUser(id)
if (err) return [null, err]

// Pattern D: Untyped throws (anti-pattern if inconsistent)
throw new Error('User not found')
```

Also check:
- Are errors logged at throw site or catch site? (not both)
- Is there a global error handler middleware?
- Are error codes/types machine-readable or human-readable strings?
- Does every external service call have a catch?

---

## Category 4: Testing Conventions

```bash
# Find test patterns
# Sample 5 test files from each major area
find . -name '*.test.*' | head -5 | xargs head -50
```

Record:

- **AAA pattern**: Arrange / Act / Assert structure present?
- **Given-When-Then**: BDD style with `describe/it` blocks?
- **Test isolation**: Each test independent (no shared state)?
- **Mock strategy**: Manual mocks / jest.mock / MSW / test doubles?
- **Factory pattern**: Test data factories / fixtures / builders?
- **Database**: In-memory DB / test DB / transaction rollback / seed files?
- **Coverage requirement**: Is there a coverage threshold in CI?

---

## Category 5: Configuration & Secrets Conventions

```bash
# Find environment variable usage
grep -r "process.env\." --include="*.ts" -h | grep -oP 'process\.env\.\w+' | sort | uniq

# Find .env files
find . -name '.env*' -not -path '*/node_modules/*'

# Check if secrets are accessed through a config wrapper
grep -r "config\." --include="*.ts" -l | head -10
```

Classify the config pattern:

| Pattern | Description |
|---|---|
| **Raw env access** | `process.env.DB_URL` used directly throughout codebase |
| **Config wrapper** | `config.db.url` via a validated config module |
| **Validation at startup** | Zod/joi/pydantic validates env vars on boot |
| **Feature flags** | Config drives feature availability |
| **Multi-env files** | `.env.development`, `.env.test`, `.env.production` |

---

## Category 6: API Design Conventions

Look for:

```bash
# Route definitions
grep -r "router\.\|app\.get\|app\.post\|@Get\|@Post\|@Controller" \
  --include="*.ts" --include="*.py" -l | head -20
```

Record:

- **URL style**: `/snake-case` / `/camelCase` / `/kebab-case`
- **Versioning**: `/api/v1/` / header versioning / no versioning
- **Response shape**: Consistent envelope (`{ data, error, meta }`) vs raw
- **Status codes**: Semantic (201 for create, 204 for delete) vs only 200/500
- **Pagination**: Cursor / offset / page-based
- **Authentication**: Bearer token / cookie / API key — where validated?
- **Input validation**: At route level / service level / both?

---

## Category 7: Type System Conventions

For TypeScript/typed languages:

```bash
# Check strictness
cat tsconfig.json | grep -E '"strict|noImplicit|strictNull'

# Count 'any' usage
grep -r ": any\b" --include="*.ts" | wc -l
grep -r "as any\b" --include="*.ts" | wc -l

# Check type-only imports
grep -r "import type " --include="*.ts" | wc -l
```

Record:

- Strict mode: on/off/partial
- `any` usage: zero tolerance / suppressed with comments / unrestricted
- Generics: used pervasively / only in library code
- Type assertions: never / sparingly / common
- DTOs vs domain models: same types / separate layers

---

## Convention Register YAML

```yaml
conventions:
  naming:
    file_style: kebab-case        # most common
    class_style: PascalCase
    function_style: camelCase
    constant_style: SCREAMING_SNAKE
    interface_prefix: false       # no 'I' prefix
    confidence: canonical         # canonical | majority | observed
    divergences: []               # files that break the pattern

  file_structure:
    module_pattern: feature-folders  # flat | feature-folders | domain-packages
    test_location: colocated         # colocated | separate | root
    barrel_files: universal          # universal | some | none

  error_handling:
    primary_pattern: result-type     # exceptions | result-type | tuple | untyped
    log_at: catch-site               # throw-site | catch-site | boundary
    global_handler: true
    machine_readable_codes: true

  testing:
    style: aaa                       # aaa | given-when-then | mixed
    mock_strategy: jest-mock
    data_strategy: factories
    coverage_threshold: 80

  config:
    pattern: config-wrapper          # raw-env | config-wrapper | validated-startup
    multi_env: true
    feature_flags: false

  api_design:
    url_style: kebab-case
    versioning: path-prefix          # path-prefix | header | none
    response_envelope: true
    semantic_status_codes: true

  type_system:
    strict_mode: true
    any_policy: suppressed-only      # zero-tolerance | suppressed-only | unrestricted
    type_assertions: sparingly

  evidence_samples: []               # 1-3 file paths per major convention
```
