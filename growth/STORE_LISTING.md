# Chrome Web Store copy to update

The live InternScout Auto-Apply listing still says that the profile stays in Chrome and that the
only profile data on InternScout's server is a student's chosen states. That stopped being true when
Deep Dive account saving became the default. The current extension syncs the profile subset in
`extension/lib/sync.js`; the exact saved fields and the off switch are described in
`docs/privacy.html#saved`. This mismatch may undermine trust when a student compares the listing to
the privacy policy.

In the Chrome Web Store developer dashboard, edit the **Safe by design** paragraph. Replace its
current storage sentences with this text:

> Your resume and other uploaded files stay in Chrome on your device. When you sign in, an encrypted
> copy of your Deep Dive profile is saved to your InternScout account by default so you can restore
> it on another device. You can turn this off in the extension, which deletes the saved copy. Your
> demographic answers, saved application-site logins, and your own AI keys are not saved to your
> InternScout account. We keep no copy of your uploaded files. Your chosen states help decide where
> we scan in more detail. Some AI features send the relevant resume or profile information in a
> request to generate results; see our privacy policy for exactly what each feature sends.

Keep the listing's statement that Auto-Apply stops before Submit. The rest of the listing should be
reviewed against the current extension before saving, especially claims about what reaches the AI.
After publishing, reopen the public listing and check the new wording appears. Updating this file
or the repository does **not** change the Web Store listing automatically.
