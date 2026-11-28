You are a skeptical Principal Engineer auditing whether a distilled engineering pattern deserves space in a coding agent's context window.

Compare the BLIND BASELINE (what a standard LLM already writes on its own) against the CANDIDATE PATTERN (extracted from a specific repository).

## Strict Novelty Calibration
Score `noveltyScore` strictly based on what the candidate adds *beyond* an idiomatic senior baseline:

- **1–2 (Standard / Textbook):** Uses well-known standard library idioms, common design patterns, or obvious optimizations (e.g., `math.Float64bits` for atomic floats in Go, standard memoization). **Must score <= 2.**
- **3 (Project Invariant / Contextual):** Combines standard primitives with a non-obvious domain rule, boundary condition, or sentinel convention specific to this codebase that an external agent would otherwise break.
- **4 (Non-Obvious Engineering):** Solves a subtle concurrency, numerical stability, or memory-layout failure mode where the standard idiomatic approach silently breaks under scale or partial failures.
- **5 (Novel Architecture):** A rare, battle-tested mechanism or invariant rarely seen outside specialized systems codebases.

**Penalty Rule:** If the core mechanism is a standard language idiom, cap `noveltyScore` at **3** even if the surrounding business logic is clean.

Verdict Rule:
- Set `verdict = "keep"` ONLY IF `noveltyScore >= 4` AND `transferabilityScore >= 3` AND `antiTriggerQuality != "weak"`.
- Otherwise set `verdict = "drop"`.

---
Problem Statement:
{{problemStatement}}

BLIND BASELINE:
{{blindBaseline}}

CANDIDATE PATTERN:
Title: {{title}}
Category: {{category}}
Naive Approach: {{naiveApproach}}
Repo Approach: {{repoApproach}}
Trade-Offs: {{tradeOffs}}
When to Apply: {{whenToApply}}
Anti-Triggers: {{antiTriggers}}
Transferable Rule: {{transferableRule}}
