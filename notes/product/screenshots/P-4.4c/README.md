# P-4.4c synthetic advisor signup evidence

The before page is the exact Accounting weekly page from #324's golden archive. The after page uses the same shell, content and local assets with the real opt-in renderer. Finance is a synthetic independently selected field, and both choices start unchecked.

| View | Before | After |
|---|---|---|
| 1280 light | [Before](before-1280-light.png) | [After](after-1280-light.png) |
| 1280 dark | [Before](before-1280-dark.png) | [After](after-1280-dark.png) |
| 375 light | [Before](before-375-light.png) | [After](after-375-light.png) |
| 375 dark | [Before](before-375-dark.png) | [After](after-375-dark.png) |

All four isolated Edge contexts passed keyboard focus and Space activation, with no overflow or page errors. Native FormData starts with no tags, contains repeated Finance and advisor tags when both are selected, and keeps Finance when advisor is cleared. Each context submits both selected combinations through the native new-tab POST. The capture harness fulfills the synthetic Buttondown action locally, blocks all other external requests and checks that browser storage is unchanged. [Run report](report.json)

Run from the repository root with Playwright Core available under `ADVISOR_CAPTURE_TOOLS` or the existing capture tools directory in `TEMP`. `ADVISOR_EDGE` can override the installed Edge executable.

```text
python notes/product/screenshots/P-4.4c/prepare.py <new-temporary-directory>
node notes/product/screenshots/P-4.4c/capture.cjs <new-temporary-directory>
```
