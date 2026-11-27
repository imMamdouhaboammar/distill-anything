# 05 — Stage 5: Skill Compiler & A/B Evaluation Harness

## 1. Progressive Disclosure Output Structure (`05-compiler/`)

For a repository distilled into `<out>/<skill-slug>/`:

```text
<out>/<skill-slug>/
├── SKILL.md                          # Lightweight index (HARD CAP: <= 1,200 tokens)
├── distill-report.json               # Provenance, costs, dropped patterns audit
└── references/
    └── patterns/
        ├── 01-<pattern-id>.md        # Deep playbook + verbatim code (HARD CAP: <= 900 tokens)
        ├── 02-<pattern-id>.md
        └── ...
```

## 2. `SKILL.md` Template Specification (`render-skill.ts`)

```markdown
---
name: {{skillSlug}}
description: Engineering playbook distilled from {{repoName}} ({{primaryLanguage}}, {{maturity.classification}}). Use when designing or reviewing {{topCategoriesList}} where {{operatingConstraintsSummary}}.
---

# {{repoName}} Engineering Playbook

- **Source**: `{{source}}` @ `{{commitShaShort}}`
- **Maturity**: `{{maturity.classification}}`
- **Operating Context**: {{operatingConstraintsJoined}}

## Pattern Decision Table
Load a pattern file from `references/patterns/` ONLY when the trigger condition matches your current task AND no anti-trigger applies.

| Pattern | Category | Load When (Trigger) | Skip When (Anti-Trigger) | Reference |
| :--- | :--- | :--- | :--- | :--- |
| {{title}} | `{{category}}` | {{whenToApply[0]}} | {{antiTriggers[0]}} | [`01-{{id}}.md`](references/patterns/01-{{id}}.md) |

## Quick Transferable Rules
{{#each patterns}}
- **{{title}}**: {{transferableRule}}
{{/each}}
```

### Deterministic Token Cap Enforcement

* Before writing `SKILL.md`, count tokens using `js-tiktoken`.
* If `SKILL.md > 1,200 tokens`: compress table cell text to <= 18 words per cell and omit `Quick Transferable Rules` overflow (never exceed 1,200 tokens).
* If any `references/patterns/*.md > 900 tokens`: trim verbatim snippet context lines (keeping core mechanism intact) while preserving exact line citations.

## 3. Individual Pattern File Specification (`render-pattern.ts`)

```markdown
# {{title}}

- **Category**: `{{category}}`
- **Maturity**: `{{maturityTag}}`
- **Evidence**: `{{evidenceStatus}}`
- **Novelty Audit**: `{{audit.noveltyScore}}/5` (Transferability: `{{audit.transferabilityScore}}/5`)

## Problem
{{problemStatement}}

## Default Approach (And Why It Breaks)
{{naiveApproach}}

## Repository Pattern
{{repoApproach}}

## Verified Source Evidence
{{#each citations}}
**`{{filePath}}` (Lines {{startLine}}–{{endLine}})**{{#if commitSha}} · Commit `{{commitSha}}`{{/if}}
```{{../language}}
{{verbatimSnippet}}
```
{{/each}}

## Trade-Offs

{{#each tradeOffs}}
* {{this}}
{{/each}}

## When to Apply

{{#each whenToApply}}
* {{this}}
{{/each}}

## Anti-Triggers (Do NOT Apply When)

{{#each antiTriggers}}
* {{this}}
{{/each}}
```

## 4. A/B Evaluation Harness (`src/eval/harness.ts`)

To prove that distilled skills measurably improve coding agent output (and prevent cargo-culting), `distill` ships with an internal evaluation harness.

### 4.1 Benchmark Suite Format (`eval/tasks/<task-id>.json`)
Each evaluation suite for a distilled skill contains **5 tasks**:
- **3 Positive Tasks**: Realistic engineering prompts where the distilled pattern SHOULD be applied.
- **2 Negative (Anti-Trigger) Tasks**: Simple CRUD/prototype prompts where applying the distilled pattern would be over-engineering and MUST be rejected.

### 4.2 Execution Protocol
For each task:
1. **Control Run (A)**: Execute target coding model with task prompt only (no skill loaded).
2. **Treatment Run (B)**: Execute same coding model with `SKILL.md` injected in system context and tool access to read `references/patterns/*.md` on demand.
3. **Deterministic + Rubric Scoring**:
   - Positive tasks score on: architectural correctness, absence of naive failure mode, and clean compilation/typecheck.
   - Negative tasks score on: **restraint** (penalize heavily if the agent forces the complex pattern despite anti-triggers).
4. **Ship Criteria**: A skill passes evaluation only if:
   - Treatment (B) beats Control (A) on `>= 2/3` positive tasks.
   - Treatment (B) passes `2/2` negative anti-trigger tasks (zero cargo-culting).

## 5. MVP Implementation Milestones

1. **Milestone 1 (Deterministic Core)**: `01-ingest.ts`, `02-signals/*`, `--dry-run` mode printing `SignalBundle` stats and exact token counts. Test on 2 real repos (1 TypeScript, 1 Rust/Python).
2. **Milestone 2 (Extraction + Grounder)**: `03-miner/extract.ts`, `03-miner/grounder.ts`, `budget.ts`, Zod schemas. Verify 100% of surviving snippets match disk lines verbatim.
3. **Milestone 3 (Novelty Gate + Compiler)**: `04-novelty/*`, `05-compiler/*`. Verify `SKILL.md <= 1,200 tokens` and dropped generic patterns appear in `distill-report.json`.
4. **Milestone 4 (Validation)**: Run `eval/harness.ts` on 1 distilled skill before publishing or expanding language grammars.
