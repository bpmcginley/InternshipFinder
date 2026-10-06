# Print flyers

## The glass-wall flyer (double-sided, 2026-10-06)

`output/pdf/internscout-glass-<spot>.pdf`, built by `growth/glass_flyer.py`. Page 1 is the front, page 2
the back. Both faces are complete flyers, because people on each side of the glass see only one of them.

| | Front | Back |
|---|---|---|
| Headline | 14,000+ internships. Every major. One free search. | Stop retyping your resume. |
| Supporting | Stop checking ten job boards; 1,700+ employers, updated several times a day | Auto-Apply fills applications on Workday, Greenhouse, Lever and more; never submits |
| .edu | ".edu email = 2× free Auto-Apply" strip | ".edu email = 2× free Auto-Apply" panel with the numbers (25 + 10 vs 12 + 5 a month) |
| QR (3 in) | bottom right, "Scan to see internships for your major" | bottom left, "Scan to search 14,000+ internships" |
| Free | "Free to use. No account. No credit card." with "Optional $4 and $8 plans only raise the AI allowance" beside it | the same |

**The printed set (2026-10-06):** `internscout-glass-general.pdf` for anywhere, and one per location:
`worcesternorth`, `worcestersouth`, `ilcnorth` (ILC North), `haigismall` (Haigis Mall), `studentunion`.
Each was checked by decoding its QR code. The "Posted" line is blank on purpose: write the date on the day
it goes up (posting rules ask for a date).

**Make one per spot.** `python growth/glass_flyer.py --spots lib,isb,su` writes one
PDF per posting location (`--posted "Oct 7, 2026"` prints a date instead of the blank line). Each QR code opens `https://internscout.org/?utm_source=flyer-<spot>&utm_medium=print`,
which the Worker counts as source `print` with its own channel per spot (`visit_channels`), so the weekly
numbers say which wall brought visits: `SELECT channel, SUM(visits) FROM visit_channels WHERE channel LIKE
'flyer%' GROUP BY channel`. Spots are 1-16 lowercase letters or digits. The role count is read from
`docs/data/stats.json` and rounded down to the thousand, so regenerate before each print run.

### Printing for glass

- **On ordinary letter copy paper (20-24 lb), print the two pages single-sided and tape them back to
  back.** One sheet of copy paper is only about 80-93% opaque, so with daylight coming through the glass a
  duplexed sheet shows the other face, mirrored, behind the text. Two sheets back to back double the paper
  in the way and make the flyer stiff enough to stay flat. Line the two sheets up against a window or a
  light, then tape them together along the top edge with a loop of tape (or a glue stick in the corners)
  before mounting. A plain sheet of dark paper between the two blocks show-through completely, if you have
  one. (2026-10-06: was "matte 80-100 lb cardstock"; standard letter paper is what's at hand.)
- Print in color at 100% / actual size. The full yellow uses a lot of toner or ink: on an inkjet the sheet
  can ripple, so let it dry flat before taping. Matte office paper is fine; gloss adds glare.
- **Cardstock, if you get it:** matte 80-100 lb cover is 97-99% opaque and can be duplexed instead.
- **If you print duplex:** portrait, **flip on long edge**, 100% / actual size, color. Walking round to the
  other side of the glass is the same as a long-edge flip, so both faces are upright. The layout is
  mirrored on purpose: the front's QR tile (bottom right) and the back's (bottom left) sit back to back, as
  do the headline blocks, so dark areas overlap rather than ghost through light ones.
- **Margins:** everything sits 0.3 in or more inside the edge, inside a 0.3 in white border, because campus
  and office printers cannot print to the edge and front/back registration drifts by up to about 1 mm.

### Mounting

- Mount on the **inside** surface only; outside glass gets wet and fogs from fall on.
- Tape the edges from the near side (the face pressed to the glass is the through-glass face; never put
  double-sided tape across it). Painter's tape leaves the least residue; use whatever the building approves.
- Put the QR codes around 4-5 ft from the floor, and avoid spots where the sun reflects straight back.
  Through glass, the 3 in code still decodes; scan at a slight angle if there is glare. (Checked: both codes
  decode from the rendered page at 100%, 50% and 30% scale.)

### Where and when

- **Head-on glass, not side glass.** A flyer flat on a wall or partition can't be read at angles under about
  30°, so pick glass people walk *toward* (doors, the end of a corridor, the wall facing a stair or queue),
  not glass running alongside a corridor.
- **Where career thinking happens:** near the career center, department lounges and study spaces, and in
  the two weeks before a career fair. In-person channels work best for intern recruiting (NACE).
- **Test before you leave:** scan the posted flyer from both sides of the glass, with an iPhone and an
  Android, at about 3 ft. Scan at a slight angle if the glass reflects.
- **Refresh every two weeks** (Student Union event postings stay up 14 days) and note the date, so a
  sheet's scans can be read against how long it was up.
- **Read the results on Mondays:** `SELECT channel, SUM(visits) FROM visit_channels WHERE channel LIKE
  'flyer%' GROUP BY channel`. Steps after a scan (posting clicks, installs) show in the dashboard's funnel.

### Before posting: UMass rules

- Campus regulation T90-079: "The use of wall space or other surfaces within or on the outside of campus
  buildings is prohibited", and posted material must name a sponsor and be dated
  ([umassp.edu](https://www.umassp.edu/bot/board-policies/t90-079)).
- Student Union: no tape "of any kind" on "walls, floors, doors, windows" without prior approval
  ([umass.edu](https://www.umass.edu/student-life/student-union/policies)); a public board takes 8.5 × 11 from
  individuals via the Info Desk.
- Libraries: only staff post, through the Information or Learning Commons desk
  ([library.umass.edu](https://www.library.umass.edu/policies-procedures/)).
- Residence halls: approval through Residential Life, and no "commercial solicitation"
  ([umass.edu](https://www.umass.edu/living/your-residential-experience/policies)).

So glass needs **written approval from each building's manager**, who can also say which tape to use. The
flyer is dated ("Posted …") and says it is an independent student project, not affiliated with UMass
Amherst; a sponsoring student organization, if a board requires one, has to be arranged separately.

### Why it looks like this (the research)

- **Stand apart:** under clutter, attention goes to whatever differs from its neighbours (Pieters, Wedel &
  Zhang 2007, 1,100+ eye-tracked ads), so a saturated yellow rather than another white sheet; black on it is
  about 15:1 contrast. Three colors only.
- **One focal element, made of words:** in free viewing, text draws about 11× more looks than other regions
  (Cerf et al. 2009), and larger text gains attention where pictures do not (Pieters & Wedel 2004), so the
  headline is the image.
- **Sized for distance:** wall-mounted signs need about 1 in of cap height per 10 ft (Garvey & Klena 2020);
  "14,000+" is about 1.1 in.
- **Free, with its condition beside it:** zero price pulls harder than its value (Shampanier, Mazar & Ariely
  2007), and the FTC's guide on "free" wants conditions next to the offer, not in a footnote
  ([16 CFR 251.1](https://www.ecfr.gov/current/title-16/chapter-I/subchapter-B/part-251/section-251.1)).
- **Exact numbers and the reader's own words:** precise figures read as researched; "ten job boards" and
  retyping a resume into Workday are complaints students voice themselves.
- **Fewer steps first:** taking a step away moves behavior far more than information does (FAFSA filing
  rose from about 40% to 55% when the form was filled in for families; Bettinger et al. 2012), so "No account
  needed" leads the front's body and "fills applications from your resume" leads the back.
- **A peer from the reader's own setting:** norms work best when they come from people like the reader
  (Goldstein, Cialdini & Griskevicius 2008), hence "Made by a UMass student" on the front, with no name.
- **A benefit line beside the QR code and the URL in type:** codes with a specific call to action are
  reported to be scanned far more than "scan me" (vendor data), and the typed URL serves anyone who will not
  scan. Size follows the 10:1 distance rule; through glass, 2.5 in or more.
- Folklore left out: the 7-word rule, the 8-second attention span, "red grabs attention", memes for credibility.

## The bulletin-board flyers (single-sided)

The two one-page PDFs `internscout-flyer-find-your-fit.pdf` and `internscout-flyer-summer-2027.pdf` are US
Letter, black type with green accents, low ink, for boards. Print at **actual size / 100%**, single-sided;
grayscale stays legible.

- `internscout-flyer-find-your-fit.pdf` is evergreen. Use it where students of several majors will see it.
- `internscout-flyer-summer-2027.pdf` is for the current recruiting season. Stop using it after Summer 2027
  recruitment.

Their QR codes lead to `https://internscout.org/` with no campaign tag. (was: "The current Cloudflare Web
Analytics setup does not record query-string campaign tags": since 2026-09-30 the site's own counter reads
utm_source, and since 2026-10-06 flyer tags count per spot, so a reprint can use the glass flyer's tagging.)
To regenerate them, install `reportlab` and run `python growth/flyers.py` from the repository root.
