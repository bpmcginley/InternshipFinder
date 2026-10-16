#!/usr/bin/env bash
# Called only by the tagged release workflow, after version and package checks.
set -euo pipefail
if gh release view "$GITHUB_REF_NAME" >/dev/null 2>&1; then
  release_tmp=$(mktemp -d "$RUNNER_TEMP/extension-release.XXXXXX")
  gh release view "$GITHUB_REF_NAME" --json assets --jq '.assets[].name' > "$release_tmp/assets.txt"
  # Validate every existing asset before uploading any missing one. The source record makes
  # a moved tag fail even if its packaged files happen to have the same contents.
  for asset in "$DEVELOPER" "$WEBSTORE" "$RECORD"; do
    name=$(basename "$asset")
    if grep -Fxq "$name" "$release_tmp/assets.txt"; then
      gh release download "$GITHUB_REF_NAME" --pattern "$name" --dir "$release_tmp"
      if ! cmp -s "$asset" "$release_tmp/$name"; then
        echo "::error::Refusing to replace $name under $GITHUB_REF_NAME. Use a new version."
        exit 1
      fi
    fi
  done
  for asset in "$DEVELOPER" "$WEBSTORE" "$RECORD"; do
    name=$(basename "$asset")
    if ! grep -Fxq "$name" "$release_tmp/assets.txt"; then
      gh release upload "$GITHUB_REF_NAME" "$asset"
    fi
  done
else
  gh release create "$GITHUB_REF_NAME" "$DEVELOPER" "$WEBSTORE" "$RECORD" --verify-tag \
    --title "InternScout extension ${GITHUB_REF_NAME#ext-v}" \
    --notes "Most people should add the extension from the Chrome Web Store instead, which updates itself: https://chromewebstore.google.com/detail/internscout-auto-apply/hpnbbpmalfjijnmpoihhjgjolhabjpgi?utm_source=github-release. To load this zip by hand: https://internscout.org/install.html#by-hand"
fi
