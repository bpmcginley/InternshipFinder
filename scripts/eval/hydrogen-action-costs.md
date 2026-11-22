# Gemini cost per action

Measured November 16, 2026 with synthetic input and live Gemini Developer API responses. Dollar figures
are estimated provider costs for 1,000 occurrences of the named action, based on observed input,
cache reads, output and thinking tokens. Each row separately applies [Google's Standard rates](https://ai.google.dev/gemini-api/docs/pricing)
through December 31, 2026 and from January 1, 2027. The figures exclude subscription revenue, other
infrastructure and browser latency. No real applications or resumes were used.

| Action | Before and candidate | Before, now | Candidate, now | Before, Jan. 1 | Candidate, Jan. 1 |
| --- | --- | ---: | ---: | ---: | ---: |
| Routine short answer | Flash-Lite standard → Flash-Lite evidence prompt | $0.71 | $0.14 | $0.71 | $0.14 |
| Short answer needing greater factual care | Flash-Lite standard → Hydrogen evidence prompt | $0.71 | $4.01 | $0.71 | $4.01 |
| Rewrite a Word resume | Flash medium → Hydrogen low with structured output | $7.90 | $8.40 | $15.80 | $8.40 |
| Rewrite an already read PDF resume | Flash medium → Hydrogen low with structured output | $9.42 | $7.90 | $18.84 | $7.90 |
| Create a template resume from a profile | Flash medium → Hydrogen low with structured output | $6.12 | $9.24 | $12.24 | $9.24 |
| Read the layout of an uncached PDF | Flash medium in both | $7.20–$12.43 | $7.20–$12.43 | $14.41–$24.85 | $14.41–$24.85 |
| Fill a batch of text fields and choose Next | Flash low in both | $2.76 | $2.76 | $5.51 | $5.51 |
| Final review after that batch, when browser proof passes | Flash low → local extension check | $2.78 | $0 | $5.55 | $0 |
| Total for the two qualifying form actions | Flash low for both → Flash low then local check | $5.53 | $2.76 | $11.07 | $5.51 |

A cached PDF layout read uses no model call. The review shortcut applies only to an already verified
read-only final page. An application that qualifies for the shortcut still pays for the earlier fill
and Next call. Pausing a resume request prevents a fallback from starting. Any already incurred
provider charge depends on when the cancellation arrives, so the table assigns no blanket savings to
pause handling.

## Short answers

Eight held-out fictional prompts covered role fit, ownership, unmeasured impact, missing experience,
and strict length limits. Each prompt ran once on four model and instruction combinations, all at
low thinking. The evidence prompt numbers candidate facts, asks for a shorter answer and returns
evidence references through a JSON schema. Local validation checks references, length, and newly
introduced digits. A reviewer assessed claims from an output file with the model names hidden.
An evidence reference is a pointer for review. It cannot establish that every statement follows from it.

| Variant | Passed / 8 | Mean tokens | Median provider time | Cost per 1,000 |
| --- | ---: | ---: | ---: | ---: |
| Flash-Lite standard | 2 | 381 | 0.64 s | $0.71 |
| Flash-Lite evidence prompt | 6 | 172 | 0.81 s | $0.14 |
| Hydrogen standard | 5 | 1,143 | 4.20 s | $7.69 |
| Hydrogen evidence prompt | 8 | 817 | 2.55 s | $4.01 |

A second set of four new examples confirmed 4/4 for each evidence prompt under the same review.
Hydrogen's median was 2.42 seconds at $4.18 per 1,000, and Flash-Lite's was 0.68 seconds at $0.105
per 1,000. Combined with the first set, Hydrogen passed 12/12 and Flash-Lite passed 10/12. This is
a comparison of isolated writing requests. Production answers generated inside an Auto-Apply
turn also pay for the surrounding form context.

## Resume rewrites

The four full-document inputs included two Word files, one PDF and one profile template.
The production extension rendered the results through its existing format and factual checks.
The tested change fixes the scope of each rewrite to evidence in the original line and uses
a schema matching the expected edit structure. PDF layout extraction remains a separate Flash
request. All 20 outputs reopened in the expected formats, with the original Word anchors retained.
This includes a follow-up plain JSON variant.

| Rewrite variant | Median provider time | Mean tokens | Unsupported scope flags / 4 | Cost per 1,000 now → Jan. 1 |
| --- | ---: | ---: | ---: | ---: |
| Flash medium, current | 15.34 s | 2,615 | 2 | $7.84 → $15.67 |
| Hydrogen low, current instructions | 4.56 s | 1,769 | 2 | $9.18 → $9.18 |
| Hydrogen low, evidence and schema | 4.77 s | 1,888 | 0 | $8.48 → $8.48 |
| Hydrogen low, evidence and plain JSON | 5.05 s | 1,554 | 0 | $8.56 → $8.56 |
| Flash low, evidence and schema | 2.53 s | 665 | 1 | $1.11 → $2.23 |

Structured Hydrogen proposed an actual rewrite or summary in all four cases, versus three for
plain JSON and two for structured Flash low. The one blinded reviewer applied the same factual
scope rules across arms. At this sample size, the result supports a limited resume pilot with
per-format review and model-aware cache identity. It does not establish a production defect rate.

## Verified final review

Three two-turn synthetic applications per model used the production request builder and retained
the models' own tool signatures. Flash and Hydrogen each performed the requested batch fill plus
Next and proposed marking the application ready for student review. Hydrogen cost $6.13 per 1,000 fill-and-Next actions and
$6.04 per 1,000 review calls in both price periods. Each verified local review removes that second
call. It does not authorize the extension to select Next or submit any additional form. The
production shortcut remains scoped to [PR #672](https://github.com/bpmcginley/InternshipFinder/pull/672).

## Reproduce

Each script defaults to a dry run. Use `--live` with `INTERNSCOUT_GEMINI_EVAL_KEY` or
`GEMINI_API_KEY` already set in the process to send the listed synthetic requests. Result and
blind review files are written under ignored `scripts/eval/hydrogen-run-*` directories.

```powershell
node scripts/eval/hydrogen_evidence.mjs
node scripts/eval/hydrogen_evidence.mjs --confirmation
node scripts/eval/hydrogen_resume.mjs
node scripts/eval/hydrogen_review_price.mjs
```

The portable resume runner shares one Flash PDF transcription across all model variants. The measured
exploratory run performed a second transcription for the plain JSON check. Both transcription
observations are reflected in the table's range.
