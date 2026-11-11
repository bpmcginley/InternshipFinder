# P-4.4 local visual evidence

Synthetic offline build; isolated Edge, 1000px viewport height, reduced motion. No external page request was allowed. The before hub is exact preliminary #321 ada9663; final #321 50726047 changes only 14 share PNG encodings, so this hub baseline is byte-identical. Weekly pages do not exist before this package; their newly added states are captured separately.

| View | Before | After |
|---|---|---|
| Majors hub 1280 light | [before](before-hub-1280-light.png) | [after](after-hub-1280-light.png) |
| Majors hub 1280 dark | [before](before-hub-1280-dark.png) | [after](after-hub-1280-dark.png) |
| Majors hub 375 light | [before](before-hub-375-light.png) | [after](after-hub-375-light.png) |
| Majors hub 375 dark | [before](before-hub-375-dark.png) | [after](after-hub-375-dark.png) |

| Added page | 1280 light | 1280 dark | 375 light | 375 dark |
|---|---|---|---|---|
| populated | [view](after-populated-1280-light.png) | [view](after-populated-1280-dark.png) | [view](after-populated-375-light.png) | [view](after-populated-375-dark.png) |
| empty | [view](after-empty-1280-light.png) | [view](after-empty-1280-dark.png) | [view](after-empty-375-light.png) | [view](after-empty-375-dark.png) |
| unmapped | [view](after-unmapped-1280-light.png) | [view](after-unmapped-1280-dark.png) | [view](after-unmapped-375-light.png) | [view](after-unmapped-375-dark.png) |
| long-name | [view](after-long-name-1280-light.png) | [view](after-long-name-1280-dark.png) | [view](after-long-name-375-light.png) | [view](after-long-name-375-dark.png) |

[Capture harness](capture.cjs), [before measurements](before-report.json), [after measurements](after-report.json). All 80 weekly links exist; phone targets are at least 44px high. Enter activation reaches the weekly page and its actual canonical parent or majors-hub fallback. Every viewport has no horizontal overflow, one h1, no page errors; added pages have self-canonical/noindex-follow metadata and no form or RSS link. Populated fixture counts 28, empty/long-name fixtures count zero, unmapped explains the missing mapping. No claim of assistive-technology execution, signup or mail delivery.
