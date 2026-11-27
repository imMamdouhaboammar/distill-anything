You are updating an existing disk-grounded Agent Skill (`{{skillSlug}}`) for repository `{{repoName}}` based on the git delta from `{{fromSha}}` to `{{toSha}}`.

## Existing Patterns
{{existingPatternsJson}}

## Git Log ({{fromSha}}..{{toSha}})
{{gitLog}}

## Bounded Code Delta (<= 30,000 tokens)
{{boundedDelta}}

## Classification Rules
1. **promote**: If an existing `experimental_technique` pattern gained production error handling, strict type guards, or unit tests in this delta, add it to `promotions` with a concise `reason` and optional `updatedCitation`.
2. **deprecate**: If an existing pattern's cited file or mechanism was deleted or replaced, add it to `deprecations` with `reason` (and an optional `replacementPattern` if a new grounded mechanism replaced it).
3. **add**: Only if a genuinely new, transferable architectural or systems pattern was introduced in this delta, add it to `additions` (it will be verified against disk and the Novelty Gate).
4. **unchanged**: Do NOT include unchanged patterns in `promotions`, `deprecations`, or `additions` — they will be preserved verbatim.

Return ONLY valid JSON matching the requested schema.
