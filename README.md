# repo-to-skill

```
     ◈ ───────────────────────────────────────────────────────────── ◈
     │                                                               │
     │   ┌────────┐        ┌──────────────┐        ┌─────────────┐   │
     │   │  CODE  │ ───►   │ CONSTITUTION │ ───►   │ AGENT SKILL │   │
     │   │  REPO  │        │  (Step 1)    │        │  (Step 2)   │   │
     │   └────────┘        └──────────────┘        └─────────────┘   │
     │     source            facts & laws             exec & evals   │
     │                                                               │
     ◈ ───────────────────────────────────────────────────────────── ◈
                   © 2026 Mamdouh Aboammar · MIT License
```

> Two-stage microservices system: reverse-engineer any codebase into an engineering constitution and synthesize an operational agent skill — 100% automated end-to-end without manual intervention.

[![npm version](https://img.shields.io/npm/v/repo-to-skill-agent?color=0f172a&label=npm)](https://www.npmjs.com/package/repo-to-skill-agent)
[![License: MIT](https://img.shields.io/badge/License-MIT-0f172a.svg)](LICENSE)
[![CI](https://github.com/imMamdouhaboammar/repo-to-skill/actions/workflows/ci.yml/badge.svg)](https://github.com/imMamdouhaboammar/repo-to-skill/actions)
[![Agent Skill](https://img.shields.io/badge/agent--skill-v1.0.0-7c3aed)](SKILL.md)
[![Hosts](https://img.shields.io/badge/hosts-Antigravity%20·%20Claude%20·%20Codex%20·%20Cursor-1d4ed8)](adapters/)

---

## Install in 10 seconds

```bash
npx repo-to-skill-agent install
```

Installs the unified skill across every AI coding agent detected on your workstation — Antigravity, Claude Code, Codex, and Cursor.

---

## Run the end-to-end pipeline in one command

Run both microservices in sequence on any GitHub URL or local directory:

```bash
# Analyze a remote repository:
npx repo-to-skill-agent run https://github.com/vllm-project/vllm

# Or analyze a local project directory:
npx repo-to-skill-agent run ./my-project --out ./dist
```

The system executes Step 1, pipes the extracted domain model into Step 2, and outputs both the engineering constitution and the operational agent skill automatically.

---

## How the two microservices link together

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  STEP 1: CONSTITUTION ENGINE (codebase-constitution)                        │
│  Harvests topology, analyzes dependencies, extracts layer boundaries,       │
│  mines implicit ADRs, distills invariants (MUST-NEVER, MUST-ALWAYS),         │
│  and codifies conventions from real code evidence.                          │
│                                                                             │
│  Output: docs/CONSTITUTION.md, topology.yaml, adr/*.md, agent-rules.yaml    │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │ (Pipes invariants, entry points, & rules)
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  STEP 2: SKILL SYNTHESIZER (repo-to-skill)                                  │
│  Consumes Step 1 domain knowledge, classifies the tool archetype,           │
│  generates a compact imperative SKILL.md (<500 lines), compiles             │
│  progressive references, and creates benchmark evals with assertions.       │
│                                                                             │
│  Output: skills/<name>/SKILL.md, references/, evals/evals.json, adapters/   │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## What it generates

Running the unified pipeline produces a complete package:

```
dist/
├── docs/                                # Step 1 Artifacts
│   ├── CONSTITUTION.md                  # 10-section engineering constitution
│   ├── topology.yaml                    # Languages, entry points, test ratio
│   ├── agent-rules.yaml                 # Machine-readable rules with code examples
│   └── adr/
│       ├── ADR-000.md                   # Architecture Decision Record index
│       └── ADR-*.md                     # Discovered implicit decisions with citations
└── skills/                              # Step 2 Artifacts
    └── <project-name>/
        ├── SKILL.md                     # Compact operational execution guide
        ├── references/
        │   ├── api-reference.md         # Full CLI flags and options
        │   ├── examples.md              # Real-world usage recipes
        │   └── configuration.md         # Manifest and environment settings
        ├── evals/
        │   └── evals.json               # Benchmark test suite with assertions
        └── adapters/                    # Host files for Antigravity, Claude, Codex, Cursor
```

Every statement in `CONSTITUTION.md` cites a verified file path. No invented flags, no fake git commit hashes.

---

## CLI reference

```bash
# Run full 2-stage automated pipeline
npx repo-to-skill-agent run <repo-url-or-local-path> [--out <dir>]

# Install skill package into local agent harnesses
npx repo-to-skill-agent install [--host <name>]

# Run standalone topology harvest
npx repo-to-skill-agent harvest [--root <dir>]

# Run quality gate verification
npx repo-to-skill-agent validate [<dir>]
```

Supported host targets for `install`:
- `antigravity` → `~/.gemini/config/skills/`
- `agents` → `~/.agents/skills/`
- `claude` → `~/.claude/skills/`
- `codex` → `~/.codex/skills/`
- `cursor` → `~/.cursor/skills/`
- `universal` → `.skills/`

---

## Usage — inside your agent

Once installed, use natural language prompts in your agent:

| Prompt | What the system does |
|---|---|
| `turn this repo into an agent skill with invariants` | Runs Step 1 then Step 2 end-to-end |
| `reverse-engineer this codebase into a constitution and generate an agent skill` | Full automated 2-stage pipeline |
| `produce an ADR backlog and constitution for this project` | Focuses on Step 1 decision archaeology |
| `skillify https://github.com/vllm-project/vllm` | Clones, extracts constitution, generates skill package |

---

## Host compatibility

| Host | Status | Target Path |
|---|---|---|
| Antigravity | `SUPPORTED_STRUCTURAL_ONLY` | `~/.gemini/config/skills/repo-to-skill/` |
| Universal Agent Skills | `SUPPORTED_TESTED` | `~/.agents/skills/repo-to-skill/` |
| Claude Code | `SUPPORTED_STRUCTURAL_ONLY` | `~/.claude/skills/repo-to-skill/` |
| Codex | `SUPPORTED_STRUCTURAL_ONLY` | `~/.codex/skills/repo-to-skill/` |
| Cursor | `SUPPORTED_STRUCTURAL_ONLY` | `~/.cursor/skills/repo-to-skill/` |

---

## Evidence rules

1. Every architecture claim cites a verified file path.
2. Every invariant cites the concrete code that enforces it.
3. Every ADR names the evidence source (file, commit range, or comment).
4. Conventions with fewer than 3 occurrences are marked "observed, not canonical".
5. Agent rules derive from codebase evidence, never generic templates.
6. Zero fabrication of git commit SHAs, line numbers, or symbols.

---

## Quality gate

Before delivering any constitution or skill, the quality gate enforces:

| Check | Standard |
|---|---|
| Evidence coverage | ≥ 80% of invariants cite verified file paths |
| ADR count | ≥ 3 implicit or explicit ADRs |
| Agent rules | ≥ 21 machine-readable rules across categories |
| Zero hallucinations | 0 unverified paths or fabricated git SHAs |
| Structure | All 10 constitution sections present |

---

## License

MIT License — Copyright (c) 2026 Mamdouh Aboammar

See [LICENSE](LICENSE) for details.

---

*Part of the [Antigravity](https://antigravity.dev) agentic engineering ecosystem.*
