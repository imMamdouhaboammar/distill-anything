# Harvest Protocol

Full checklist for Step 1 (Topology Harvest) of the Codebase Constitution skill.

---

## Phase A: Directory Structure

```bash
# Full tree to depth 3 (adjust for large monorepos)
find . -maxdepth 3 \
  -not -path '*/.git/*' \
  -not -path '*/node_modules/*' \
  -not -path '*/.venv/*' \
  -not -path '*/target/*' \
  -not -path '*/__pycache__/*' \
  -not -path '*/dist/*' \
  -not -path '*/build/*' \
  | sort

# Count files by type
find . -type f \
  -not -path '*/.git/*' \
  -not -path '*/node_modules/*' \
  | sed 's/.*\.//' | sort | uniq -c | sort -rn | head -30
```

## Phase B: Entry Point Detection

Look for (in order):

```
main.{ts,js,py,go,rs,rb,java,kt,swift,cpp,c}
index.{ts,js,py}
app.{ts,js,py,rb}
server.{ts,js,py,go,rb}
cmd/*/main.go
bin/*
src/main.*
lib/index.*
__main__.py
Makefile (look for `run:` or `start:` targets)
package.json (look for `"main"`, `"bin"`, scripts.start/dev)
Cargo.toml (look for [[bin]])
pyproject.toml (look for [project.scripts])
```

## Phase C: Build System Detection

| File | Build System |
|---|---|
| `package.json` | npm/bun/yarn/pnpm |
| `bun.lockb` | Bun |
| `Cargo.toml` | Rust/cargo |
| `go.mod` | Go modules |
| `pyproject.toml` | Python (poetry/uv/pip) |
| `requirements.txt` | pip |
| `pom.xml` | Maven |
| `build.gradle` | Gradle |
| `Gemfile` | Ruby/bundler |
| `mix.exs` | Elixir/mix |
| `Makefile` | Make |
| `CMakeLists.txt` | CMake |
| `flake.nix` | Nix |

## Phase D: CI/CD Detection

Look for:

```
.github/workflows/*.yml
.gitlab-ci.yml
.circleci/config.yml
bitbucket-pipelines.yml
Jenkinsfile
.travis.yml
azure-pipelines.yml
cloudbuild.yaml
.buildkite/pipeline.yml
```

## Phase E: Infrastructure Detection

Look for:

```
terraform/          *.tf files
pulumi/             Pulumi.yaml
cdk/                cdk.json / cdk.out
ansible/            playbooks, roles
helm/               Chart.yaml
k8s/                *.yaml with kind: Deployment|Service|...
docker-compose.yml
Dockerfile
fly.toml
vercel.json
netlify.toml
wrangler.toml
```

## Phase F: Test Structure Detection

```bash
# Find test directories
find . -type d -name '*test*' -o -type d -name '*spec*' -o -type d -name '__tests__' \
  | grep -v node_modules | grep -v .git

# Count test files vs source files
find . -type f \( -name '*.test.*' -o -name '*.spec.*' -o -name 'test_*.py' -o -name '*_test.go' \) \
  | grep -v node_modules | wc -l
```

## Phase G: Config File Audit

Collect:

```
.env.example / .env.template  → environment variable surface
*.config.{ts,js,mjs}           → tool configs
tsconfig.json / jsconfig.json  → TypeScript config
.eslintrc* / biome.json        → linting rules
.prettierrc*                   → formatting
jest.config.* / vitest.config.* → test config
.editorconfig                  → editor norms
```

## Topology Card Template

```yaml
topology:
  repo_name: ""
  git_sha: ""            # run: git rev-parse --short HEAD
  languages:
    - name: ""
      file_count: 0
      percentage: 0.0
  entry_points: []
  module_count: 0
  test_file_count: 0
  source_file_count: 0
  test_ratio: 0.0
  config_files: []
  build_tools: []
  ci_files: []
  infra_files: []
  monorepo: false
  packages: []           # for monorepos
  approximate_loc: 0     # lines of code
```
