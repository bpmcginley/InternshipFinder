# Claude Haiku 5.5 vs Gemini 3.8 Flash for Auto-Apply (offline form benchmark, 2026-10-13)

Data: 30 real, open internship forms (12 Greenhouse, 9 Lever, 9 Ashby), filled offline as the fictional
student Jordan Rivera (`bench_profile.mjs`; every link is on example.com). How it works: README.md,
"Offline form benchmark". Tables regenerate with `node scripts/eval/form_bench.mjs report`
(`bench-tables.md`, git-ignored).

## Verdict: stay on flash-low

No cheaper config passed the decision rule, with or without the bracket fix. Both Haiku configs cost
about a third of flash-low per application now, and about a sixth to a seventh from 2027, when
Flash's price doubles. Haiku also wrote clearly better free text and stopped to ask more often where only the student
knows the answer. It still made more sensitive errors, mostly through one tool-use habit: it calls
`click` on radio groups and `check` on Yes/No questions. Production carries those calls out, and they
changed EEO answers from "decline" to a specific race, gender and veteran status, and answered "Yes" to
"will you need sponsorship". If that habit is fixed (see "What switching would need"), haiku-medium is
worth re-running. On today's evidence it does not qualify.

The rule was fixed before any results were read: a cheaper config qualifies if (1) its objective
accuracy is no more than 2 points under flash-low's (production) or higher, (2) it has no more sensitive
errors than flash-low, (3) it has no more invalid tool calls than flash-low, counted both as production
is today and with the bracket fix, and (4) its free text is not worse: judged overall score at most 0.15
under flash-low's, and no more invented claims. Among the configs that qualify, the cheapest one wins.

| Config | Accuracy within 2 pts | Sensitive errors <= flash-low | Invalid calls, as-is | Invalid calls, bracket fix | Free text not worse | Qualifies |
|---|---|---|---|---|---|---|
| flash-medium | yes (96.6%) | yes (5) | **no** (5 vs 2) | **no** (5 vs 2) | yes | no (and 2.4x the cost) |
| haiku-low | **no** (91.0%, -2.3) | **no** (10 vs 5) | **no** (455 vs 2) | **no** (5 vs 2) | yes | no |
| haiku-medium | yes (91.7%, -1.6) | **no** (7 vs 5) | **no** (485 vs 2) | **no** (8 vs 2) | yes | no |

The evidence is thin, so read the counts with care. The sensitive errors are 5, 7 and 10, and each
config makes most of its errors on the same form in both runs, so there are really 3-6 distinct
mistakes per config (all listed below). The invalid-call gap after the fix is 2 against 5-8 out of
about 500 calls each. The rule is strict on purpose, but a different draw of 30 forms could flip the
sensitive-error check. What will not change with more data: Haiku's tool-use habit is real and it is
systematic.

## Main results (first step on every form, 2 runs each, 60 form-runs per config)

| Config | Objective accuracy (same 223 fields x 2 runs for all) | Sensitive errors | Missed required | Invented values | Invalid calls, bracket fix / as-is | Clicks on form fields | Human-only questions answered | Free text, judged 1-5 (answers) | Invented claims in free text | Run-to-run consistency | Cost per application now / 2027 | Latency p50 / p90 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| flash-low (production) | 93.3% (416/446) | 5 | 10 | 7 | 2 / 2 of 484 | 0 | 53 | 2.56 (36) | 55 | 97.9% | $0.0135 / $0.0271 | 3.9 s / 8.0 s |
| flash-medium | 96.6% (431/446) | 5 | 5 | 6 | 5 / 5 of 504 | 0 | 49 | 2.92 (40) | 51 | 97.7% | $0.0318 / $0.0637 | 13.9 s / 29.4 s |
| haiku-low | 91.0% (406/446) | 10 | 16 | 0 | 5 / 455 of 532 | 21 | 33 | 3.97 (39) | 12 | 95.9% | $0.0040 / $0.0040 | 5.2 s / 7.8 s |
| haiku-medium | 91.7% (409/446) | 7 | 20 | 0 | 8 / 485 of 527 | 8 | 29 | 4.29 (38) | 7 | 95.7% | $0.0043 / $0.0043 | 5.6 s / 8.8 s |

- **Accuracy** counts only the model's share of each form: fields fastFill left empty, plus fastFill's
  wrong pre-fills. Restraint fields (optional, and the profile can't answer them) are counted under
  "Invented values" instead.
- **Sensitive errors** are wrong non-empty answers on work authorization, sponsorship, EEO, age, dates,
  GPA and similar questions. Since this write-up they also include a right pre-fill that the model
  overwrote on a sensitive field (see below).
- **Clicks on form fields** are `click` calls aimed at a field instead of a button. On a radio group,
  production's `ISDom.act` clicks the group's element, which is its first option.
- **Human-only questions answered** are fields the answer key marks as only the student can answer: a
  consent, a commitment the profile doesn't make, or a fact it lacks. They are not scored, but every one
  is listed in `bench-tables.md`.
- **Cost per application** is uncached at 3.2 steps (production's measured mean), from each call's real
  token counts.

### Why the earlier tables compared 162 fields with 146

The first `bench-tables.md` (flash-low 150/162, the others 146) was written at 10:43 on 2026-10-09,
before the run finished at 10:50 (it reports "Gemini $0.33 over 54 calls"). Each config had a
different number of finished form-runs, so each was scored on a different set of fields. The scored
set depends only on the form and on what fastFill pre-filled, so with all 240 form-runs present every
config scores the same 223 fields per run. The report now scores every config only on the (form, field)
pairs that all configs have, and it lists each config's own count beside that, so the comparison stays
fair even when a run fails. Today the two are identical.

## Accuracy per run

| Config | Run 1 | Run 2 | Errors / refusals |
|---|---|---|---|
| flash-low | 93.7% | 92.8% | 0 / 0 |
| flash-medium | 96.4% | 96.9% | 0 / 0 |
| haiku-low | 91.9% | 90.1% | 0 / 0 |
| haiku-medium | 91.5% | 91.9% | 0 / 0 |

There were no refusals and no API errors in 240 form-runs.

## Cost

| Config | Uncached per step | Per application, uncached, now / 2027 | Per application with the fixed opening cached after step 1, now / 2027 | Mean prompt / output tokens per step |
|---|---|---|---|---|
| flash-low | $0.0042 | $0.0135 / $0.0271 | $0.0085 / $0.0171 | 4,311 / 267 |
| flash-medium | $0.0100 | $0.0318 / $0.0637 | $0.0268 / $0.0536 | 4,311 / 1,791 |
| haiku-low | $0.0013 | $0.0040 / $0.0040 | $0.0031 / $0.0031 | 6,629 / 1,203 |
| haiku-medium | $0.0014 | $0.0043 / $0.0043 | $0.0034 / $0.0034 | 6,629 / 1,390 |

Per month, uncached (the cached column above is the floor):

| Config | 19 apps, now / 2027 | 300 apps, now / 2027 | 3,000 apps, now / 2027 |
|---|---|---|---|
| flash-low | $0.26 / $0.51 | $4.06 / $8.13 | $40.65 / $81.29 |
| flash-medium | $0.61 / $1.21 | $9.55 / $19.11 | $95.53 / $191.05 |
| haiku-low | $0.08 / $0.08 | $1.21 / $1.21 | $12.14 / $12.14 |
| haiku-medium | $0.08 / $0.08 | $1.30 / $1.30 | $13.04 / $13.04 |

Claude counts more prompt tokens for the same request (6.6k against 4.3k) and thinks more at "low", but
at $0.10 / $0.50 per million tokens against Flash's $0.75 / $3.75 it still comes out 3.1-3.4x cheaper now
and 6.3-6.8x cheaper in 2027. At September's 19 applications, the saving is a few cents a month.

## Second step (10 forms x 2 runs, on the page step 1 left)

| Config | Step-1 outcome (all 60) | Step-2 outcome (20) | Accuracy on those forms, after step 1 / after step 2 | New invalid calls, bracket fix / as-is | Re-writes of right answers | Human-only questions answered by the end |
|---|---|---|---|---|---|---|
| flash-low | continue 56, ask 4 | ready 18, continue 2 | 94.4% / 94.4% | 0 / 0 | 1 | 22 |
| flash-medium | continue 57, ask 2, ready 1 | ready 20 | 96.3% / 96.3% | 0 / 0 | 0 | 20 |
| haiku-low | continue 58, ask 2 | ask 7, ready 6, continue 7 | 90.7% / 96.3% | 0 / 20 | 13 | 13 |
| haiku-medium | continue 60 | ask 7, ready 6, continue 7 | 93.2% / 96.9% | 0 / 18 | 8 | 13 |

Haiku leaves more for its second step. On these 10 forms it passes flash-low's accuracy by the end of
step 2. The subset is small, though, and the main table scores only step 1, so this is a hint that
single-step scoring understates Haiku, not a result.

**Haiku's "ask" decisions** were mostly right to ask, and Flash's "ready" on the same forms was often
wrong:
- **Astranis** (both Haiku configs, both runs): the form asks whether the student will commit to 55
  hours a week onsite in San Francisco, and for consent to recruiting SMS messages. The profile says 40
  hours a week, and only the student can give consent, so the key marks both "human only". Haiku asked
  the student. All four Flash runs answered **"Yes" to both**, committing the student to 55 hours and
  opting them into SMS.
- **Cybernetic Labs** (all four Haiku runs): "What's the most interesting paper, blog post, or
  documentation you've read in the past month?" is required, and the profile has no reading list. Haiku
  asked. Every Flash run **made up an answer** ("Recently I re-read the PostgreSQL documentation and
  engineering write-ups on B-tree indexing...") and marked the application ready.
- **TensorWave**: the form asks "available for the full duration, May 25 - Aug 20, 2027?" and the
  profile's availability ends Aug 13. Haiku asked, or answered "No" (right). Every Flash run answered
  "Yes", a sensitive error.
- A few asks were unneeded. "Do you have any agricultural experience? If yes, please explain"
  (Compeer, haiku-medium run 1) has an obvious "No". The Mercedes-Benz start date was asked about even
  though the profile gives May 24, 2027.

Each ask costs the student an interruption, but none of Haiku's asks were harmful.

**Haiku's re-writes** were harmless. 13 and 8 of its step-2 calls wrote a field step 1 had already got
right. Nearly all of them wrote the same value again: Compeer, haiku-low run 2, re-selected "Yes" for
work authorization and 18+, plus "Decline" for the three EEO questions. The single changed value was the
human-only question "How did you hear about us", from "Company Website" to "Indeed" (Hermeus, haiku-low
run 2). The real costs are tokens and a slightly longer run. One step-2 rewrite fixed a step-1 mistake:
Mercedes-Benz sponsorship, "Yes" to "No" (haiku-low run 1). Flash re-wrote one right answer.

## Free text (Claude Opus 5.5 as a blind judge)

The judge was `claude-opus-5-5` with adaptive thinking at effort high, JSON by schema, and no sampling
parameters. Each question's answers from all 8 config-runs were shuffled and labelled A, B, C, ... with
no hint of where they came from. The judge scored each answer 1-5 on relevance, truthfulness to the
fictional profile, fit (length, tone, format, limits) and overall, and listed every claim the profile
does not support. It graded 153 answers to 22 questions on 16 forms, for $0.78.

| Config | Answers | Overall | Relevance | Truthfulness | Fit | Invented claims (answers with any) | Mean length | Overall run 1 / run 2 | Paired with flash-low, same question: mean diff (questions worse / better) |
|---|---|---|---|---|---|---|---|---|---|
| flash-low | 36 | 2.56 | 3.78 | 3.67 | 2.72 | 55 (21) | 527 | 2.61 / 2.50 | - |
| flash-medium | 40 | 2.92 | 3.95 | 3.83 | 3.08 | 51 (23) | 578 | 2.95 / 2.90 | +0.31 over 18 (2 / 10) |
| haiku-low | 39 | 3.97 | 4.54 | 4.59 | 4.23 | 12 (12) | 562 | 3.90 / 4.05 | +1.42 over 18 (1 / 17) |
| haiku-medium | 38 | 4.29 | 4.47 | 4.82 | 4.50 | 7 (7) | 601 | 4.42 / 4.16 | +1.72 over 18 (0 / 18) |

Overall-score spread: flash-low had 19 of 36 answers at 1-2 and 3 at 4-5. Haiku-low had 30 of 39 at
4-5, and haiku-medium 35 of 38.

What the judge flagged:
- **Flash** wrote generic, corporate prose ("I am excited to bring an analytical, hands-on approach to
  launching new markets...") and inflated facts: "built multiple automated data validation pipelines"
  (the profile has one service), "over 1,200 students" (it says about 1,200), and the 9 s to 1.2 s
  speed-up credited to the wrong project.
- **Haiku**'s invented claims were smaller ones: "co-led CampusEats" (the profile says lead developer),
  "spent the last year on the data side" (a three-month internship), "built dashboards".

This was the one check where Haiku was clearly better.

### Why free text first showed 0 answers for every config

It was not the forms, and it was not the models. 18 of the 30 forms carry 22 free-text questions in
the key, and step 1 wrote a 260-1,000 character answer to every required one. The only gaps were two
optional "Additional information" boxes, which every config left empty. The `judge` phase had simply never run: the earlier agent stopped after
`run`, so `bench-judge.json` did not exist and the report read an empty judge.

The report also treated a missing judge as a pass. The decision rule's free-text check was
`!b.free.n || ...`, which is true when nothing was graded, and the table printed 0.00 as if it were a
score. Both are fixed: an ungraded run now fails the free-text check and prints "not graded".

## The failures that matter (fictional student; real public postings)

1. **Haiku clicks radio groups, and production clicks the first option.** On Base Power
   (haiku-medium run 1), fastFill had already set Gender, Race and Veteran status to "decline". Haiku
   then called `click` on each group, which left **Gender = Male, Race = Hispanic or Latino, Veteran =
   "I identify as one or more of the classifications of protected veteran"**. The same thing happened
   on Crest Industries (haiku-low run 1, Race) and Base Power (haiku-low run 2, Veteran). These are the
   worst errors in the benchmark. They are now counted as sensitive errors. Before this write-up they
   were listed only under "pre-filled answers it broke".
2. **Haiku uses `check: true` on Yes/No radio groups, and production maps that to "Yes".** On
   Mercedes-Benz (haiku-low run 1), "Will you now or in the future require sponsorship...?" became
   **Yes**. Cirrus Logic's "Were you referred by a current Cirrus Logic employee?" became Yes in three
   Haiku runs. The same pattern, with `click`, produced "Yes" to "completed your junior year" (Hermeus)
   and to "currently a Freshman or Sophomore" (Base Power).
   - **What a production guard would change:** if production rejected `click` on fields and `check` on
     radio groups, and those fields were left as they were, an offline estimate (no new calls) drops
     Haiku's sensitive errors to 3 (haiku-medium) and 3 (haiku-low), against flash-low's 5.
   - **What it would cost:** single-step accuracy falls to 90.6% and 88.1%, because those fields then
     wait for a later step.
3. **Flash commits the student to things only the student can agree to:** 55 hours a week onsite and
   SMS consent (Astranis), an invented "most interesting paper" answer (Cybernetic Labs), and "available
   for the full duration" when the profile ends a week early (TensorWave). Haiku asked in each case.
4. **A production fastFill bug** (not a model error): `guard.js` CHOICE_FACTS `over_18` matches "Are
   you **under** the age of 18?" ("age of 18"), so fastFill answers it **"Yes"**. Every config but
   flash-low fixed it in step 1. Flash-low's step 1 ended with an `ask_user` about references, so the
   "Yes" stayed in both runs and counts as 2 of its 5 sensitive errors. This should be fixed whatever
   model runs Auto-Apply.
5. **Haiku writes refs with brackets.** In 455 of 532 calls (haiku-low) and 485 of 527 (haiku-medium),
   it copied the snapshot's `[0:6]` as the ref. Today's `execTool` rejects every one of them (below).

All sensitive errors:
- **flash-low (5):**
  - "Are you under the age of 18?" = Yes, Crest Industries, runs 1 and 2 (fastFill's, left in place).
  - "Available for the full duration (May 25 - Aug 20, 2027)?" = Yes, TensorWave, runs 1 and 2.
  - "Desired Start Date" = 01/18/2027, Integra FEC, run 2 (the key and profile say May 24, 2027).
- **flash-medium (5):**
  - "Have you completed your junior year...?" = Yes, Hermeus, runs 1 and 2.
  - "Available for the full duration?" = Yes, TensorWave, runs 1 and 2.
  - "Please provide visa status and expiration if applicable" = "U.S. Citizen", DRW, run 1 (optional;
    the key expects blank).
- **haiku-low (10):**
  - Junior year = Yes, Hermeus, runs 1 and 2 (click).
  - Freshman or Sophomore = Yes, Base Power, runs 1 and 2 (click).
  - "Will you need housing?" = No, Protective Life, runs 1 and 2 (the key says Yes or Unsure).
  - Race = Hispanic or Latino, Crest Industries, run 1 (overwrote "decline").
  - Sponsorship = Yes, Mercedes-Benz, run 1 (check).
  - Graduation "(Month, Year)" = "Spring 2028", Protective Life, run 2.
  - Veteran = protected veteran, Base Power, run 2 (overwrote "decline").
- **haiku-medium (7):**
  - Junior year = Yes, Hermeus, run 1.
  - Freshman or Sophomore = Yes, Base Power, run 1.
  - Gender, Race and Veteran overwritten, Base Power, run 1 (clicks).
  - "Are you comfortable commuting to this job's location?" = No, SHEIN, run 2 (two copies of the
    field).

## Haiku's bracketed refs and production's `execTool`

`extension/background/agent.js` `execTool` (line 806 on this branch) looks the ref up as given:

```js
const t = needsRef ? index[input.ref] : null;
if (needsRef && !t) return { content: `Unknown ref ${input.ref}. Use refs from the latest snapshot.`, isError: true };
```

`index` is keyed `"0:6"`, so `"[0:6]"` gets "Unknown ref", and today about 85-91% of Haiku's calls
would fail. The model would probably retry without the brackets on its next step, so the real cost is
extra steps rather than a dead run, but the bench can't measure that. The one-line fix goes first
thing in `execTool`:

```js
if (typeof input.ref === "string") input.ref = input.ref.trim().replace(/^\[(.*)\]$/, "$1");
```

The bench applies exactly this fix (`bench_run.mjs applyCalls`), so every number above except the
"as-is" columns assumes it is in. This report does not change production code.

## Changes to the scoring in this write-up

All four changes are in `bench_lib.mjs` and `bench_report.mjs` and are tested in
`extension/test/form_bench.test.mjs`.
- **Overwritten sensitive pre-fills count as sensitive errors.** A right pre-fill that the model
  overwrote on a sensitive field (EEO, sponsorship, ...) is now a sensitive error. It was only listed
  before, so it never reached the decision rule.
- **Accuracy uses the same field set for every config.** It is scored over the (form, field) pairs all
  configs have, and each config's own count is shown beside it.
- **New columns:** "clicks on form fields", "human-only questions answered", invalid calls both with
  and without the bracket fix (now for step 2 too), and a paired free-text comparison.
- **One key correction, made after the results were read** (`KEY_FIXES`): Leland's free-text box "What
  is your expected graduation month and year?" now accepts any answer containing "May 2028". The date
  reader couldn't parse "Spring 2028 (May 2028)". The change removes two of haiku-low's sensitive errors
  and changes nothing else. Without it, haiku-low has 12 sensitive errors and 90.6% accuracy.

## Caveats

- **The forms are offline copies.** Each form is redrawn from the ATS's public question data. There is
  no account creation, no multi-page flows, no conditional questions that appear after an answer, no
  slow or flaky page scripts, and no Workday or iCIMS. Live pages are harder.
- **Mostly single-step.** The main table scores only the first step (3.2 steps make an application in
  production), and the step-2 subset is 10 forms. Haiku defers more to later steps, so single-step
  accuracy probably understates it a little.
- **Small numbers.** 30 forms, 2 runs, and 3-6 distinct sensitive mistakes per config. One form
  (Hermeus, Base Power or TensorWave) can swing a check.
- **Possible judge bias.** The judge is a Claude model grading Claude against Gemini. It was blind to
  the source, but style can give the source away, and self-preference is a known bias. Haiku's lead is
  large (+1.4 to +1.7 on a 5-point scale, better on 17-18 of 18 questions) and matches the invented-claim
  counts, so the direction is probably right. The size may be overstated.
- **The answer key** comes from rules plus Claude Opus 5.5, hand-checked on 2026-10-09, with three
  recorded corrections (`KEY_FIXES`). Some entries are judgement calls, for example Protective Life's
  housing question.
- **Haiku sees a bigger prompt.** Claude counts about 1.5x the prompt tokens Gemini does for the same
  request, which is already in the cost figures. No prompt was tuned for Haiku: it got production's
  system prompt and tools, which were written for Gemini.

## What switching production would need

1. **A Claude route in the Worker.** `worker/src/index.js` `POST /ai` calls only `callGemini` from
   `worker/src/gemini.js`. It needs a new `worker/src/anthropic.js` (or a provider branch) with
   Anthropic's equivalents of `sanitizeRequest` (max_tokens and effort ceiling per task, tool list),
   `callGemini` (including streaming, as `readUsageFromSSE` does), and `costCents` / `estimateCents`
   for allowance accounting. An `ANTHROPIC_API_KEY` secret is needed too.
2. **Config.** In `worker/src/config.js`, set `TASKS.autofill.model` to `claude-haiku-5-5` with its
   provider and effort ("medium" if anything; "low" failed the accuracy check), add a `PRICES` entry
   ($0.10 / $0.50 / $0.01 cached per million tokens, $0.50 / $2.50 over 100k), and update the `COSTS`
   allowance units.
3. **The extension's model call path.** `extension/background/claude.js` `callAI` sends the
   InternScout provider to `callWorker` in `extension/background/gemini.js`, which expects
   Gemini-shaped replies (thought signatures, function-call ids). The Worker has to return the shape
   `agent.js` already reads, or `callWorker` needs a Claude branch. Also, `callClaude` (own-key path)
   drops `thinking` for Haiku and sends no `output_config.effort`.
4. **The ref-bracket fix** in `agent.js` `execTool` (the line above).
5. **A guard against Haiku's tool-use habit.** Before switching, reject `click` on a field ref
   (non-button) and `check` on a radio group in `execTool` (or `ISDom.act`), with an error that says to
   use `select` with the option text. Tighten the tool descriptions in `agent.js` `TOOLS` too. Then
   re-run this benchmark for haiku-medium; at about $0.15 for two runs, it is cheap.
6. **A fallback to Flash.** Haiku 5.5 has no server-side refusal fallback. The Worker should retry the
   step on gemini-3.8-flash when Haiku returns `stop_reason: "refusal"`, a 5xx/529 after retries, or a
   reply with no tool call, and log how often that happens.
7. **Separately, the fastFill bug** (failure 4) in `extension/agent/guard.js`: leave "under 18"
   questions to the model.

## Spend

| | Gemini | Anthropic | Total |
|---|---|---|---|
| Earlier agent (key, all runs) | $1.04 | $1.55 (Opus key about $1.41, Haiku runs about $0.14) | $2.59 |
| This write-up (blind judge, 16 Opus calls) | $0.00 | $0.78 | $0.78 |
| **Total** | **$1.04** | **$2.33** | **$3.37** of the $15 cap |

No new model runs were needed: every model call reused the saved `bench-runs.json`.
