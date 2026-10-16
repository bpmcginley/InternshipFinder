# Extension 0.5.8 candidate

Prepared October 16, 2026. This is a local release candidate, not a published release.
The source starts from main `cbfef6171f08ebc4f9c06a41523519b630a120aa`.

Local consolidated verification: all 315 extension tests passed, including nine new synthetic
Lever/Ashby regressions. Two packaging/release tests passed,
including timestamp-independent rebuilds and five mocked publisher scenarios (identical retry,
changed ZIP, changed source record, missing asset and new release). The publisher tests use local
fixtures and no GitHub requests. The release workflow also parses as valid YAML.

## Included changes

- Carry forward PR #118's existing Take over focus timeout, used dashboard-session check and manual
  details wording. Those fixes are on main but absent from the published 0.5.7 package. They were not
  rewritten for this candidate.
- Enable the existing optional Monday email link on the two setup completion screens. It opens
  the site's signup page; the extension does not read, submit or subscribe an email address.
- Bump the manifest and release assertion to 0.5.8. Permissions and host access are unchanged.

The public Google update artifact inspected on October 16 had manifest version 0.5.7 and SHA-256
`d247ecd4ead9280e656b63b89d299fc21d8ad8f8249118e3ccaf10f4be019ca0`.
Its `background/index.js`, `lib/auth.js` and `lib/entry.js` matched release commit `a212f811`
after newline normalization; none contained the corresponding PR #118 fix.

## Automated checks and package record

Run from the candidate's clean source commit:

```text
node --test extension/test/*.test.mjs
python -m unittest discover -s scripts -p 'test_release_extension.py'
python scripts/release_extension.py
```

The release helper uses the existing package script and writes both files to ignored `dist/`, outside
the published site. It refuses modified tracked source and untracked package inputs so a recorded
commit identifies the build:

- `internscout-extension-0.5.8.zip`: developer/manual install, with the existing identity key.
- `internscout-extension-0.5.8-webstore.zip`: Chrome Web Store upload, without that key.

The local `dist/release-verification-0.5.8.json` records the exact source commit, SHA-256 and byte
size of each built ZIP, manifest checks, PR #118 runtime markers, enabled digest link, and a byte-for-byte
comparison of packaged runtime files with that source commit. It is an external build record, not a
committed credential or a publication claim. If the candidate changes, rebuild and regenerate the record.

The tag workflow now publishes both ZIPs and a `-source.json` record with their source commit and hashes.
ZIP entry metadata and text line endings are fixed so Windows checkout settings and filesystem dates
do not change the package. A retry compares existing assets
byte for byte before uploading anything missing, and rejects a different asset under the same version.
It never uses `--clobber`. This does not make the store or GitHub release publish automatically on merge;
the existing `ext-v*` tag trigger remains.

Both packages must have manifest version 0.5.8 at ZIP root, no localhost bridge matches, no test/fixture
files, and the same permissions as the source manifest. Only the developer ZIP retains `key`.

## Manual checks still pending

These are release gates, not claimed successes. The October 14 installed-extension fixture tests used
a local stub identity service and scripted AI. They did not test real Google or Microsoft sign-in.

- [ ] Load the exact developer candidate into a separate test browser/profile; confirm 0.5.8.
- [ ] Check popup, setup and side-panel layout, keyboard focus and the optional email link on both
      completion screens. The link must open `/digest/` without submitting or sharing an address.
- [ ] Test real Google sign-in, sign-out and account restoration using an authorized test account.
- [ ] Test a supported personal Microsoft account; school/work Microsoft accounts remain unsupported.
- [ ] Check an unused dashboard sign-in offer, then verify a previously copied session is not offered.
- [ ] Verify Take over foregrounds a slow fixture tab promptly while cancellation remains effective.
- [ ] Verify missing manually entered name/email requests details instead of another resume review.
- [ ] Verify an existing profile, resume and saved credentials survive a normal update. Keep private
      data out of screenshots, logs and this repository; do not submit an employer application.

## Publication handoff

No tag, push, GitHub release, Chrome Web Store submission, merge or deployment was performed while
preparing this candidate. After review and the manual checks, the owner can authorize publication.
Use the exact recorded Web Store ZIP rather than an earlier 0.5.7 artifact. A matching GitHub release
should attach the developer ZIP so the install page's `releases/latest` route no longer serves 0.5.6.
Reopen the public store and GitHub download after publication and check versions and hashes.

Keep the draft release notes in `growth/STORE_LISTING.md` separate from the listing's actual saved
state. Updating repository text does not change either store or release metadata.
