# Is Flash-Lite good enough for Auto-Apply?

Auto-Apply runs on Gemini 3.8 Flash. Flash-Lite costs about 60% less per token and doesn't double in price
on 2027-01-01, but it's a smaller model. This test decides whether it can take over for form pages,
on real applications, before any student gets it.

## 1. Record some real steps (your own profile)

1. Load the extension from this branch (or the store build once it has shipped).
2. Open `chrome://extensions`, find InternScout, click **service worker** to open its console, and run:
   ```js
   await ISEval.start()
   ```
3. Run Auto-Apply on 10 or more real applications of different kinds: at least 2 Workday, 2 Greenhouse,
   2 Lever or Ashby, 1 iCIMS, and some with free-text questions. Stop each one at "ready to submit" as
   usual. You don't need to submit anything.
4. Back in the console:
   ```js
   await ISEval.count()                              // steps recorded, aim for 100+
   copy(JSON.stringify(await ISEval.export()))      // copies them to the clipboard
   await ISEval.stop(); await ISEval.clear()
   ```
5. Paste the clipboard into `scripts/eval/steps.json`. This file holds your profile and the pages you
   applied to. It's in `.gitignore`, so don't force-add it, and delete it when you're done.

## 2. Replay them against both models

From the repository root, with your own Gemini API key, the same kind the Worker uses:

```bash
GEMINI_API_KEY=your-key node scripts/eval/autofill_models.mjs scripts/eval/steps.json
```

Each recorded step is sent to Flash-Lite, and to Flash a second time. Flash's second try measures how
often the production model disagrees with itself, which is the fair bar for a cheaper model. About
100 steps cost roughly $1 in total. The report goes to `scripts/eval/eval-report.md`.

## 3. Read the report

- **Field decisions agreeing:** how often the model filled a field the same way the recorded run did.
- **Sensitive disagreements:** differences on work authorization, sponsorship, EEO, age, salary,
  graduation and similar questions. These are listed first, one by one.
- **Missed / extra fields:** fields only one of the two filled.
- **Free-text answers:** set side by side for you to judge. They are not scored automatically.

Suggested rule for switching: Flash-Lite's field agreement within 3 points of Flash's own, **zero**
sensitive disagreements, and free-text answers you'd be happy to send. If it passes, the next step
is routing form pages without free-text questions to Flash-Lite, with a fall-back to Flash after a
failed action. That's a Worker change followed by a deploy.
