# 04 — Stage 3 & Stage 4: Pattern Miner, Grounder & Novelty Gate

## 1. Stage 3: Evidence-Based Pattern Mining (`03-miner/`)

### 1.1 System Prompt Contract (`prompts/miner-system.md`)
```markdown
You are a Staff Systems Engineer reverse-engineering a repository to extract transferable engineering playbooks for coding agents.

STRICT RULES:
1. Extract ONLY concrete architectural, concurrency, memory, type-safety, state, or error-resilience patterns directly visible in the provided source files and git diffs.
2. NEVER output generic software engineering advice (e.g., "use dependency injection", "write unit tests", "handle errors gracefully", "separate concerns", "use TypeScript strict mode").
3. Every pattern MUST cite exact file paths and 1-indexed line ranges from the provided numbered source files, with verbatim code snippets.
4. Tag `evidenceStatus` honestly:
   - `seen_explicit`: the rationale is explicitly stated in comments, ADRs, or commit messages.
   - `inferred_from_code`: you deduced the rationale from the implementation structure.
5. Tag `maturityTag` honestly:
   - `production_proven`: backed by tests, error handling, or production constraints.
   - `experimental_technique`: clever algorithm or research prototype with missing edge-case guards.
6. Every pattern MUST include at least 2 strict `antiTriggers` stating concrete conditions where using this pattern in another codebase would cause unnecessary complexity or failure.
7. Prefer 4 to 8 high-leverage patterns over 12 diluted ones. If the repository contains fewer than 3 genuinely non-obvious patterns, output only what exists.
```

### 1.2 Deterministic Snippet Grounder (`03-miner/grounder.ts`)

Runs immediately after LLM extraction with zero LLM calls:

1. For each `CandidatePattern`, iterate over `citations`:
* Verify `filePath` exists in the repository (inside `subpath`).
* Read actual lines `[startLine, endLine]` from disk.
* Normalize whitespace (trim trailing spaces, normalize `\r\n` to `\n`) on both disk slice and `verbatimSnippet`.
* Compute token/line overlap ratio:
* If overlap `>= 0.85`: **PASS**. Replace `verbatimSnippet` with the exact disk slice to guarantee 100% fidelity.
* If overlap `< 0.85`: run a sliding-window search across the same file to handle off-by-N line number drift. If exact match found, auto-correct `startLine`/`endLine` and **PASS**.
* If still not found: reject the citation.

2. If a pattern loses all valid citations, drop the pattern and log it under `groundingFailures`.
3. If `> 50%` of candidates fail grounding, retry Stage 3 once with the specific grounding errors appended. If retry fails, exit with code `5`.

## 2. Stage 4: Novelty & Anti-Fluff Gate (`04-novelty/`)

This stage runs in parallel (`Promise.all` with concurrency limit `4`) across all grounded candidate patterns.

### 2.1 Step A — Blind Baseline Generation (`baseline.ts`)

Prompt the `--judge-model` with **ONLY** the pattern's `problemStatement` and the repository's `primaryLanguage` (zero mention of the repo name, zero snippets, zero hints):

```markdown
Language: {{primaryLanguage}}
Engineering Problem: {{problemStatement}}

Provide the idiomatic, production-grade implementation approach and concise code sketch you would write to solve this problem. Be specific about data structures, concurrency primitives, and edge cases. Max 300 words.
```

### 2.2 Step B — Head-to-Head Judge (`judge.ts`)

Pass `(problemStatement, blindBaseline, candidatePattern)` to the `--judge-model` using `NoveltyJudgeOutputSchema`:

```markdown
You are a skeptical Principal Engineer auditing whether a distilled engineering pattern deserves space in a coding agent's context window.

Compare the BLIND BASELINE (what a standard LLM already writes on its own) against the CANDIDATE PATTERN (extracted from a specific repository).

Scoring Rubric for `noveltyScore`:
- 1: Baseline already uses the exact same pattern and handles the same trade-offs.
- 2: Candidate only adds minor syntactic polish or standard library idioms.
- 3: Candidate has a slightly better detail, but the core architecture is identical to baseline.
- 4: Candidate uses a distinct, concrete mechanism or invariant the baseline missed, producing measurable performance, safety, or reliability gains.
- 5: Candidate reveals a non-obvious architectural technique, memory layout, or failure-mode defense that standard LLMs consistently miss.

Verdict Rule:
- Set `verdict = "keep"` ONLY IF `noveltyScore >= 4` AND `transferabilityScore >= 3` AND `antiTriggerQuality != "weak"`.
- Otherwise set `verdict = "drop"`.
```

### 2.3 Deterministic Gate Enforcement

Even if the judge sets `verdict = "keep"`, code enforces the hard threshold:

```typescript
const passed =
  audit.verdict === "keep" &&
  audit.noveltyScore >= 4 &&
  audit.transferabilityScore >= 3 &&
  audit.antiTriggerQuality !== "weak";
```

If zero patterns pass Stage 4, exit with code `4` and write `distill-report.json` explaining why each candidate was dropped.
