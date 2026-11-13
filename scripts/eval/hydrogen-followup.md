# Gemini writing and multi-step form follow-up

## Writing

We ran 55 live calls on 10 fictional prompts, with five application answers and five individual
resume bullets. The first sweep paired Flash and Hydrogen with the same settings and either standard
or evidence-focused instructions. We then repeated the evidence-focused resume requests at low
thinking and tested Flash-Lite on the five evidence-focused short answers. Each arm had one sample
per prompt.

| Short application answers | Score / 30 | Unsupported / 5 | Over limit / 5 | Median | Mean tokens | Cost per 1,000 now → Jan. 1 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Flash-Lite, evidence-focused | 25 | 1 | 1 | 0.84 s | 230 | $0.21 → $0.21 |
| Flash, standard | 25 | 4 | 0 | 2.13 s | 421 | $1.15 → $2.29 |
| Flash, evidence-focused | 26 | 0 | 1 | 2.08 s | 509 | $1.42 → $2.83 |
| Hydrogen, standard | 30 | 0 | 0 | 3.47 s | 990 | $6.35 → $6.35 |
| Hydrogen, evidence-focused | 26 | 0 | 0 | 3.98 s | 1,120 | $7.21 → $7.21 |

| Resume bullet rewrites | Thinking | Score / 30 | Unsupported / 5 | Median | Mean tokens | Cost per 1,000 now → Jan. 1 |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Flash, standard | Medium | 28 | 1 | 9.45 s | 1,433 | $4.95 → $9.90 |
| Flash, evidence-focused | Medium | 29 | 0 | 14.41 s | 1,795 | $6.35 → $12.71 |
| Hydrogen, standard | Medium | 29 | 0 | 6.75 s | 1,533 | $10.44 → $10.44 |
| Hydrogen, evidence-focused | Medium | 30 | 0 | 7.15 s | 1,591 | $10.97 → $10.97 |
| Flash, evidence-focused | Low | 29 | 0 | 6.57 s | 978 | $3.29 → $6.58 |
| Hydrogen, evidence-focused | Low | 30 | 0 | 3.55 s | 909 | $5.86 → $5.86 |

One reviewer scored relevance, factual fidelity, and voice on a scale of zero to two each and
flagged unsupported claims. The multi-arm reviews hid model names. The separate Flash-Lite run
used the same rubric with one model. The sample covers single bullets and answers, so it does not
measure complete resume output, formatting or validation. Some runs overlapped, and latency
is local API completion time. Costs include thinking tokens and use [Google's standard paid
rates](https://ai.google.dev/gemini-api/docs/pricing), with the Flash change on January 1, 2027.

Evidence-focused low-thinking Hydrogen held the same resume score as medium Hydrogen while using
43% fewer tokens and taking about half as long at the median. Compared with evidence-focused
low-thinking Flash, it used 7% fewer tokens, was 46% faster at the median, and cost 11% less at the
January rates. Standard Hydrogen had the best short-answer score, while Flash-Lite had the lowest
cost and latency. Evidence-focused Flash produced zero unsupported claims in the five application
answers, with one answer over the length limit.

## Simulated two-page forms

The first sweep ran all 32 combinations of eight fictional forms and four variants in 66 calls.
Both current model workflows passed 8/8. Both routed workflows passed 7/8. They stalled on the same
intentionally blank optional field.

The second sweep used the same deterministic prefill and production history trimming for all four
arms. It also gave the routed arms an explicit way to leave an unsupported optional field blank.
All 32 runs passed, including the case that required asking the student about unknown authorization.
There were 64 provider calls and zero provider errors or proposed critical actions.

| Two-page form variant | Passes | Calls across 8 forms | Median | Mean tokens per form | Cost per 1,000 now → Jan. 1 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Flash, current tools | 8/8 | 21 | 4.90 s | 9,292 | $6.48 → $12.96 |
| Hydrogen, current tools | 8/8 | 19 | 4.51 s | 8,979 | $13.89 → $13.89 |
| Flash, local navigation | 8/8 | 12 | 1.93 s | 3,480 | $2.81 → $5.63 |
| Hydrogen, local navigation | 8/8 | 12 | 3.36 s | 3,832 | $7.61 → $7.61 |

With current tools, Hydrogen needed two fewer calls and used 3% fewer total tokens, with an 8%
lower median. It still cost about 7% more at the January rates. Each locally routed arm bypassed
the model on four of its sixteen pages. Locally routed Flash used 63% fewer tokens and took 61% less
median time than Flash with the current tools. It cost 57% less per simulated form in both periods.

The simulator retains each model's own tool signatures across turns and checks proposed fields against
handwritten expected values. Its local navigation sees only fixture controls and whether fields are
filled or explicitly skipped. The simulated gate does not establish whether a live website has
finished validating a form. The prefill rules are shared across arms but cover fewer field types
than the production extension. The simulator does not measure Chrome or ATS delays, and it checks
the form prose only for presence and length. The separate writing experiment scores prose quality.

## Routing candidates

Keep Flash-Lite as the routine short-answer candidate, with checks for length and supported claims.
Test low-thinking Hydrogen on whole resumes and use the same claim validation and layout checks.
The best form candidate was Flash with code handling routine prefill and navigation. Test that
against the actual extension on locally served ATS forms with the production guards before a release.
Standard Hydrogen is a candidate when an application answer warrants the higher cost and latency.

These experiments vary instructions, the model's thinking level, and which work the model performs.
They do not train model weights. [The Gemini Developer API tuning page](https://ai.google.dev/gemini-api/docs/model-tuning)
points to the separate Enterprise Agent Platform for supervised fine-tuning, and its
[supported model list](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/tuning/supervised-tuning#supported_models)
does not currently list Hydrogen or 3.8 Flash.

## Reproduce

Run the benchmark scripts without `--live` to see the request plan. Set the same Gemini key
environment variable used by [the original pilot](README.md#gemini-4-hydrogen-and-the-compact-auto-apply-workflow)
before adding `--live`.

```powershell
node scripts/eval/hydrogen_writing.mjs --live
node scripts/eval/hydrogen_writing.mjs --live --resume-low
node scripts/eval/hydrogen_writing.mjs --live --application-lite
node scripts/eval/hydrogen_forms.mjs --live
node scripts/eval/hydrogen_forms.mjs --live --match-prefill
```

Results and blind writing outputs go in ignored `hydrogen-run-*` folders. The forms use a simulated
two-page workflow and never open or submit an employer application.
