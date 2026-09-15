# Using `agy` (Antigravity CLI) for AI delegation

`agy` is Google's replacement for the old Gemini CLI (Google killed Gemini CLI for
personal/Pro accounts on 2026-06-18). It runs on Bruce's Google AI Pro plan and is
used to offload cheap, low-stakes work — mainly **web research** — so it doesn't
burn Claude Code tokens.

## Binary

Not on PATH reliably yet. Always call it by full path:

```bash
"C:\Users\bruce\.agy\bin\agy.exe"
```

Sign-in is already done (Google account brucepmcginley@gmail.com) and saved to
`~/.gemini/antigravity-cli/`, so no login needed to run it.

## The one command that works

```bash
agy -p "<task>. Reply directly, no plan, no clarifying questions." \
  --mode accept-edits --dangerously-skip-permissions --print-timeout 60s
```

Example — web research:

```bash
"C:\Users\bruce\.agy\bin\agy.exe" -p "Search the web for the latest funding round \
raised by <company>, with a source link. Reply directly, no plan, no clarifying \
questions." --mode accept-edits --dangerously-skip-permissions --print-timeout 60s
```

Piping text in for summarizing/drafting:

```bash
cat some_notes.txt | "C:\Users\bruce\.agy\bin\agy.exe" -p "Summarize in 5 lines. \
Reply directly, no plan, no clarifying questions." --mode accept-edits \
--dangerously-skip-permissions --print-timeout 60s
```

## Flags that matter — don't skip these

| Flag | Why |
|---|---|
| `--mode accept-edits` | **Never use `--mode plan`.** Despite the name, plan mode drafts a plan and waits for a human to click "Proceed" — that click never happens headlessly, so the call hangs until timeout. |
| `--dangerously-skip-permissions` | Without it, a tool call needing permission auto-denies with no output, since headless mode can't prompt. |
| `--print-timeout 60s` | Default timeout is short; research/summarize calls take ~15-30s. |
| `"Reply directly, no plan, no clarifying questions."` in the prompt | Stops it from stopping to ask you something instead of answering. |

## Known limitation — do not fight this

**Never ask `agy` to read, list, or search local files itself.** As of 2026-09-15,
any task where it touches the filesystem on its own hangs indefinitely (tested to
3 minutes, no completion), regardless of mode or permissions flags. Root cause not
identified — it isn't file count or a missing `rg`.

Workaround: if it needs file content, read the file yourself (or have Claude do it)
and paste/pipe the content into the prompt. Text-only in, text-only out — no
`agy`-driven file access.

## What to delegate here

Good fits:
- Web research / current info lookups
- Summarizing text you paste/pipe in
- First-pass boilerplate or draft text from a spec you hand it

Bad fits:
- Anything needing it to browse this repo's files
- Security, secrets, money, or the final call on a bug — verify its output before acting on it

## If something breaks

- Hangs past ~60s on a task that should be simple → it's probably trying to touch
  files; kill it and rephrase to avoid file access.
- Asks to sign in again / errors about auth or quota → stop, don't retry in a loop,
  tell Bruce.
