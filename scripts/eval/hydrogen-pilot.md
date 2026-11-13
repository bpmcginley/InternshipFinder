# Gemini Hydrogen Auto-Apply pilot

The November 13, 2026 run completed all 96 Gemini Developer API calls with token usage for every call. It used 12 fictional snapshots, two repeats, low thinking, and the production 4,096-token output limit. The four variants ran sequentially in rotated order. This pilot used the benchmark at commit `8e76abbd7`.

| Model and workflow | Strict passes | Median | p95 | Mean tokens | Cost per 1,000 steps through Dec. 31 | Cost per 1,000 steps from Jan. 1 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Flash, current | 16/20 | 1.76 s | 3.79 s | 3,354 | $2.22 | $4.44 |
| Hydrogen, current | 14/20 | 2.31 s | 5.38 s | 3,538 | $5.68 | $5.68 |
| Flash, compact | 14/20 | 1.81 s | 2.86 s | 2,172 | $1.85 | $3.70 |
| Hydrogen, compact | 17/20 | 2.70 s | 11.24 s | 2,433 | $5.16 | $5.16 |

This table uses the 20 ordinary form attempts per variant. It excludes four consent and verification probes per variant. The compact workflow shortens the prompt and limits the tool list to the page. Token counts include input, visible output, and thinking. Cost is a modeled estimate using observed cache reads and [Google's standard paid rates](https://ai.google.dev/gemini-api/docs/pricing), including the January 1, 2027 Flash rate change. The 96-call run models $0.35 at the introductory Flash rate and $0.44 at the January rate. These estimates do not verify an invoice.

- **Hydrogen with the current workflow** was 32% slower at the median and used 5.5% more tokens than current Flash. Its average step cost was 2.55 times the current Flash cost and 28% higher after January 1.
- **Compact Flash** used 35% fewer tokens and cost 17% less in both periods. Its median was similar and its p95 was lower in this sample. It missed two more strict passes than current Flash.
- **Compact Hydrogen** produced the most strict passes. It used 27% fewer tokens than current Flash, but its median was 54% slower and its average step cost was 16% higher under January rates. It proposed marking a form ready after failing to fill a required writing field.

On the separate consent and verification probes, current Flash passed 2/4. It proposed readiness on both consent attempts. The other three variants passed 4/4. The production consent guard can intercept this before the model call or action.

One reviewer scored four prose answers per variant while the model names were hidden. Each answer could earn up to six points for relevance, factual support, and voice. Current Hydrogen scored 24/24 with no unsupported claims flagged. Compact Flash scored 19/24 and current Flash 18/24, with unsupported details in two answers each. Compact Hydrogen scored 18/24 with one missing answer and no unsupported claims flagged in the other three. One Flash answer invented zero backend downtime.

The pilot supports keeping current Flash for Auto-Apply. None of the candidates cleared the benchmark's quality gate. Most ordinary-form misses came from a single response filling fields and leaving the final readiness step to a later turn. A multi-page replay needs to measure that second turn, actual field values, and cache behavior. The results also support testing Hydrogen on a separate set of writing tasks, where the early signal was factual grounding. This pilot used one fictional profile and two prose prompts. The p95 and writing scores are preliminary.
