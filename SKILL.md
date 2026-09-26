---
name: repo-to-skill
description: >
  Two-stage unified microservices engine that reverse-engineers any codebase into an
  engineering constitution and synthesizes an operational agent skill end-to-end automatically.
  Step 1 (codebase-constitution) extracts architecture decisions, invariants, conventions,
  technology contracts, and implicit ADRs from code evidence. Step 2 (repo-to-skill)
  takes that domain knowledge and synthesizes an operational skill package with SKILL.md,
  references, deterministic scripts, and benchmark evals. Use when asked to "turn this repo into
  an agent skill", "reverse-engineer this codebase into a constitution", "extract engineering
  principles", "produce an ADR backlog", "skillify this project", or generate living agent
  instructions from a repository.
version: "1.0.0"
author: "Mamdouh Aboammar"
copyright: "Copyright (c) 2026 Mamdouh Aboammar. All rights reserved."
license: MIT
repository: "https://github.com/imMamdouhaboammar/repo-to-skill"
hosts:
  - antigravity
  - agents
  - claude
  - codex
  - cursor
  - universal
tags:
  - repo-to-skill
  - codebase-constitution
  - agent-skill
  - architecture
  - reverse-engineering
  - adr
  - agent-rules
  - invariants
---

<!--
  ╔═════════════════════════════════════════════════════════════════════════════╗
  ║                 REPO TO SKILL & CONSTITUTION ENGINE                         ║
  ║                                                                             ║
  ║  Copyright (c) 2026 Mamdouh Aboammar. All rights reserved.                 ║
  ║  Licensed under the MIT License.                                            ║
  ║  Repository: github.com/imMamdouhaboammar/repo-to-skill                     ║
  ╚═════════════════════════════════════════════════════════════════════════════╝
-->

# Repo-to-Skill & Constitution Engine

> Two-stage microservices system: reverse-engineer any codebase into an engineering constitution and synthesize an operational agent skill — 100% automated end-to-end without manual intervention.

**Author:** Mamdouh Aboammar · **License:** MIT · **Version:** 1.0.0

$$\text{Raw Codebase} \xrightarrow{\text{Stage 1: Constitution Engine}} \begin{pmatrix} \text{Topology} \\ \text{Invariants} \\ \text{ADRs} \\ \text{Conventions} \end{pmatrix} \xrightarrow{\text{Stage 2: Skill Synthesizer}} \begin{pmatrix} \text{SKILL.md} \\ \text{References} \\ \text{Evals Benchmark} \\ \text{Host Adapters} \end{pmatrix}$$

---

## When to activate

**Activate** on requests like:
- "turn this repo into an agent skill"
- "reverse-engineer this codebase into a constitution and generate a skill"
- "skillify this repository"
- "extract engineering principles and create a skill for this project"
- "generate a CONSTITUTION.md and skill package from this repo"
- "produce an ADR backlog and agent rules from code"
- "what are the invariants and usage rules in this system?"

**Do NOT activate** on:
- "explain this single function" → use code-explainer
- "fix this bug" → use ce-debug
- "review this PR" → use agency-code-reviewer

---

## The Two-Stage Automated Pipeline

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  STAGE 1: CONSTITUTION ENGINE (codebase-constitution)                       │
│  ├─ PASS 1: Topology Harvest        → language mix, entry points, test ratio│
│  ├─ PASS 2: Dependency Audit        → package manager, version locks        │
│  ├─ PASS 3: Architecture Extraction → layers, boundaries, communication     │
│  ├─ PASS 4: Decision Archaeology    → implicit ADRs from comments & git log │
│  ├─ PASS 5: Invariant Distillation  → MUST-NEVER / MUST-ALWAYS / MUST-WHEN  │
│  ├─ PASS 6: Convention Codification → naming, errors, testing conventions   │
│  └─ PASS 7: Agent Rule Synthesis    → machine-readable agent-rules.yaml     │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │ (Piped domain facts & invariants)
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  STAGE 2: SKILL SYNTHESIZER (repo-to-skill)                                 │
│  ├─ Tool Classification             → CLI, Library, Framework, or Service  │
│  ├─ Operational SKILL.md            → compact (<500 lines), imperative steps│
│  ├─ Progressive References          → API reference, examples, config docs │
│  ├─ Verification Smoke Test         → executes help, install, and core paths│
│  └─ Benchmark Evaluation            → evals.json with binary assertions     │
└─────────────────────────────────────────────────────────────────────────────┘
```

Both stages execute in a single sequence without requiring human intervention.

---

## Command Invocation

```bash
# Analyze and synthesize in one shot:
npx repo-to-skill-agent run <repo-url-or-local-path> [--out <output-dir>]

# Install skill package across all agent hosts on your machine:
npx repo-to-skill-agent install
```

---

## Output Contract

Executing the pipeline produces:

```
dist/
├── docs/                                # Stage 1: Constitution Artifacts
│   ├── CONSTITUTION.md                  # The 10-section engineering constitution
│   ├── topology.yaml                    # Language breakdown & package manifest audit
│   ├── agent-rules.yaml                 # Machine-readable behavioral rules
│   └── adr/
│       ├── ADR-000.md                   # ADR index
│       └── ADR-*.md                     # Discovered implicit decisions with evidence
└── skills/                              # Stage 2: Operational Skill Package
    └── <project-name>/
        ├── SKILL.md                     # Operational agent execution guide
        ├── references/
        │   ├── api-reference.md
        │   ├── examples.md
        │   └── configuration.md
        ├── evals/
        │   └── evals.json               # Benchmark test prompts and assertions
        └── adapters/                    # Antigravity, Claude, Codex, Cursor, Universal
```

---

## Evidence Invariants

- Every architecture claim cites a verified file path.
- Every invariant cites the concrete code enforcing it.
- Every ADR names the evidence source (file, commit, or comment).
- Zero hallucination of git commit SHAs or non-existent symbols.
- Agent rules must derive from codebase evidence, never generic templates.

*Copyright (c) 2026 Mamdouh Aboammar. All rights reserved. MIT License.*
