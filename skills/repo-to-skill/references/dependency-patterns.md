# Dependency Patterns — Audit Guide

Reference for Step 2 (Dependency Audit) of the Codebase Constitution skill.

---

## Package Manager Detection

Run in target repo root:

```bash
# Node.js ecosystem
ls package.json bun.lockb yarn.lock package-lock.json pnpm-lock.yaml 2>/dev/null

# Python
ls requirements.txt requirements-dev.txt pyproject.toml Pipfile.lock 2>/dev/null

# Rust
ls Cargo.toml Cargo.lock 2>/dev/null

# Go
ls go.mod go.sum 2>/dev/null

# Ruby
ls Gemfile Gemfile.lock 2>/dev/null

# Java/Kotlin
ls pom.xml build.gradle build.gradle.kts 2>/dev/null
```

---

## Pinning Strategy Classification

| Lockfile | Pinned version indicator |
|---|---|
| `bun.lockb` | Always exact (binary) |
| `package-lock.json` | Always exact |
| `yarn.lock` | Always exact |
| `pnpm-lock.yaml` | Always exact |
| `Cargo.lock` | Always exact |
| `go.sum` | Always exact (checksums) |
| `Gemfile.lock` | Always exact |
| No lockfile | **UNPINNED — flag as risk** |

For `package.json` declared ranges:
- `"1.2.3"` → exact (safest)
- `"^1.2.3"` → caret (allows minor + patch)
- `"~1.2.3"` → tilde (allows patch only)
- `">=1.2.3"` → range (most permissive, risky)
- `"*"` → wildcard (critical risk)

---

## Dependency Categories

Extract and categorize:

```bash
# For package.json — show all deps with their declared range
cat package.json | grep -A999 '"dependencies"' | head -50
cat package.json | grep -A999 '"devDependencies"' | head -50
```

| Category | Examples |
|---|---|
| Web framework | express, fastify, hono, next.js, nuxt |
| ORM / DB client | prisma, drizzle, sequelize, typeorm, sqlalchemy |
| Validation | zod, joi, yup, pydantic |
| Auth | passport, lucia, next-auth, jose |
| Testing | jest, vitest, pytest, go test |
| Build / bundle | esbuild, vite, webpack, tsc |
| Linting | eslint, biome, rubocop, golangci-lint |
| HTTP client | axios, got, httpx, fetch |
| Queue / messaging | bullmq, kafka-js, amqplib |
| Logging | pino, winston, structlog, slog |
| Observability | opentelemetry, datadog, sentry |
| Cache | ioredis, keyv, memcached |

---

## Deprecated / EOL Package Detection

Common patterns to flag:

```bash
# For Node.js — check for known deprecated packages
node -e "const p = require('./package.json'); const deps = {...p.dependencies,...p.devDependencies}; 
const deprecated = ['request','node-fetch@2','moment','lodash','mkdirp','rimraf']; 
deprecated.filter(d => deps[d]).forEach(d => console.log('DEPRECATED:', d))"
```

Well-known deprecated packages to flag:

| Package | Replaced by |
|---|---|
| `request` | native `fetch` / `got` / `axios` |
| `moment` | `date-fns` / `dayjs` / `Temporal API` |
| `lodash` | native ES2023 methods |
| `node-fetch@2` | native `fetch` (Node 18+) |
| `webpack@4` | webpack@5 / Vite / esbuild |
| `tslint` | ESLint with TypeScript plugin |

---

## Security Signal Detection

```bash
# Check for known CVE patterns in lock file (basic)
# If npm audit is available:
npm audit --audit-level=high 2>/dev/null || echo "npm audit not available"

# Bun audit (if supported):
bun audit 2>/dev/null || echo "bun audit not available"

# For Python:
pip-audit 2>/dev/null || echo "pip-audit not available"
```

**Flag as security signals:**
- Direct dependency with known CVE (critical or high)
- Dependency with version matching a known vulnerable range
- Use of crypto/auth packages that are no longer maintained

---

## Dependency Contract YAML

```yaml
dependency_contract:
  package_manager: bun        # bun | npm | pip | cargo | go | bundler | ...
  direct_count: 0             # count of production dependencies
  dev_count: 0                # count of dev dependencies
  lock_file_present: true
  pinning_strategy: exact     # exact | caret | tilde | range | unpinned
  
  notable_runtime_deps:
    - name: ""
      version: ""
      role: ""
      
  dev_dep_categories:
    - testing
    - linting
    - build
    
  deprecated_packages: []     # packages that should be migrated
  
  security_signals:
    - package: ""
      version: ""
      cve: ""                 # if known
      severity: ""
      
  license_categories:
    permissive: 0             # MIT, Apache 2.0, BSD
    copyleft: 0               # GPL, LGPL — review required
    proprietary: 0            # flag for legal review
    unknown: 0
    
  version_drift_risk: low | medium | high   # based on pinning strategy
```
