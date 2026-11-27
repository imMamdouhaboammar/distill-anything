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
