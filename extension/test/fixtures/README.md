# Offline application fixtures

`lever-like.html` and `ashby-like.html` are small, **synthetic** application forms with fictional
employers. They are not downloaded employer pages, and passing them does not establish live ATS
compatibility. Both refuse outgoing forms through CSP and a submit handler; they use no external
assets, scripts, endpoints or applicant records.

`node --test extension/test/ats_forms.test.mjs` runs the production guard, action helpers and page
model in isolated JavaScript contexts against minimal fake DOM controls. The assertions cover:

- full-name/contact prefill and preserving an existing student edit;
- exactly one application resume attachment, preserving it on repeated prefill, and declining to
  guess between two resume destinations;
- excluding an Ashby-style parser upload and a cover-letter field from automatic resume attachment;
- sponsorship suggestions staying blank until explicitly confirmed;
- Ashby-style required fieldset captions identifying a radio question separately from its answers;
- Take over preventing later fields and a late file action from changing;
- recovery of an email reference after a React-style replacement;
- ordinary review navigation allowed while final and consent buttons stay blocked for the agent.

The Node harness deliberately does **not** simulate a browser's CSS/layout, full selector engine,
file security model, React handlers, or trusted human click dispatch. The
HTML companions are available for separately recorded browser checks; the Node suite does not load
them or validate their layout. Existing `fastfill_facts`, `dom_halt`, `guard_review_consent` and
`agent_takeover` suites cover the shared factual-confirmation, cancellation and submission rules.

For a manual offline check using only a fictional profile: inspect the contact fields, attach a
dummy resume, confirm the parser/cover-letter inputs remain empty, move to review, return to edit,
and use the Ashby fixture's email replacement button. The final button only records a local status
message. Never interpret that message as a real employer submission or test on a real application
merely to validate these fixtures.
