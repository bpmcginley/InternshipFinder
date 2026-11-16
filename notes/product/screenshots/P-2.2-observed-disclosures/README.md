# Top-up launch disclosures

The before images use the product copy at `88b3ebec629e9833c3c976417307754a7e956182`.
The after images use the proposed source in this branch. Each capture shows the complete top-up
section through its next heading. Local Edge rendered both pages at 1280 and 375 CSS pixels in
light and dark mode. The browser served the checkout's files from an offline origin and blocked
external requests. It used no account, payment, or provider data.

The capture checked the approved three-sentence privacy paragraph, the deletion wait sentence,
the original notice before the change, its removal in the after copy, and the original terms
price and employer contract date. All 16 captures fit their viewport width and had no page errors.
[Capture results](report.json)

The normal offline site build changed exactly `privacy.html` and `terms.html` across 846 files.
Both golden tests passed, and the refreshed archive matches all 846 manifest hashes.
[Golden comparison](golden-report.json)
