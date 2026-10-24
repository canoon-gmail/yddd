# Where to post YDDD (milestone 1: first user comments)

Goal: comments from people who would actually print something with it, not stars.
Rules below are from memory — anything marked **verify** must be checked on the
community's sidebar / wiki the day you post. Rules change.

## Before posting anything (blockers)

1. **Add a LICENSE file.** package.json says MIT but the repo has no LICENSE file.
   Someone will point this out in the first 10 comments. Also say in README that the
   bundled OpenCascade wasm is LGPL-2.1 (README already notes it).
2. **One GIF or 30–60 s video** at the top of the README (e.g. the Cable Storage Box
   or Planter walkthrough from the Help menu, ending in Export 3MF → slicer).
   Every channel below works far better with a picture.
3. **Install path.** Right now it's `git clone && npm install && npm start`. Many
   r/3Dprinting readers will stop there. An AppImage on a GitHub Release would
   roughly double who can try it. If not ready, say so honestly in every post.
4. Be around for 3–4 hours after each post to answer. Post one channel at a time,
   fix what the first one finds, then do the next.

## Ranked list

| # | Channel | Audience fit | Self-promo rules (as I know them) | Best timing | Lead angle |
|---|---|---|---|---|---|
| 1 | **r/functionalprint** | Very high: people who design useful printed parts, many find Fusion/FreeCAD heavy | Posts are meant to be *printed objects*, not software. A post that shows a real printed part made in YDDD fits; a pure software ad may be removed. **verify** | Weekday, 14:00–16:00 UTC (US morning) | Photo of a real printed part (box + lid, planter) + "I designed this in my own small CAD app, want feedback" |
| 2 | **r/3Dprinting** | High, huge, many beginners who find CAD the hard part | Allows own projects; spam/self-promo limited (Reddit's general ~10% guideline). Software posts OK if you engage. **verify** flair rules | Weekday 14:00–17:00 UTC; avoid Fri evening | "CAD is the hardest part of printing for beginners — I'm trying to make it simpler. Does this help?" |
| 3 | **Show HN** (news.ycombinator.com) | Medium-high: developers, interest in OpenCascade-in-wasm, Electron, direct modeling | Must be something people can try; no vote asking; title starts "Show HN:"; you should be in comments. Text post or URL to repo. | Tue–Thu, 13:00–15:00 UTC (US morning) | Technical + honest: Electron + Three.js + OpenCascade wasm, B-rep exact, worker kernel; a solo hobby project |
| 4 | **r/linux** | Medium: Linux users who complain there's no Fusion 360 on Linux | Self-promo of own software allowed only sparingly; rule about "no low-effort posts"; some days restricted. **verify** | Weekday 13:00–16:00 UTC | "Fusion 360 doesn't run on Linux; FreeCAD is powerful but steep. I made a small, simple one." |
| 5 | **r/opensource** (also r/linuxapps, small) | Medium: small but friendly to new FOSS apps | r/opensource: project posts OK if the project is open source with a license (**add LICENSE first**). **verify** | Any weekday | "New MIT CAD app, looking for testers & comments" |
| 6 | **Mastodon** (#3DPrinting #Linux #FOSS #CAD #OpenSource) | Medium, very FOSS-friendly, slow but kind feedback | No rules beyond instance rules; hashtags are how people find it. Don't spam multiple identical toots. | Weekday European afternoon (13:00–17:00 UTC) | Short GIF + "solo FOSS CAD for Linux, what's missing for your prints?" |
| 7 | **Thai maker groups** (Facebook: 3D Printer Thailand / Thai 3D printing groups, Maker Thailand; Pantip Gadget/คอมพิวเตอร์ room) | High for the Thai text angle: Thai letters work in Text, built-in Noto Sans Thai | Facebook groups: admins often require approval; some ban selling, OK for free tools. **verify** with each group's rules / ask admin. | Evening Thailand time, 19:00–22:00 ICT | "Free CAD where you can type Thai text and push it into raised letters for name tags / signs" |
| 8 | **r/cad** | Medium-low: many pros using SolidWorks/Fusion; will compare harshly but usefully | Small sub, project posts usually tolerated. **verify** | Weekday | "Direct modeling, no history tree — is that a dealbreaker for you?" |
| 9 | **r/FreeCAD** | Low-medium; risky (could feel like poaching). Only if framed as "complementary, for simple parts" and maybe ask mods first | Off-topic promo of other apps may be removed. **verify / ask mods** | — | Skip in milestone 1, or ask mods |
| 10 | **Printables / Thingiverse** | Indirect: upload a model *made in YDDD* (with .yddd + STEP + 3MF), mention the app in the description | Model uploads must be printable models; ads for software not wanted. Printables forum/"Prusa forum" has a software section. **verify** | Anytime | "Designed in YDDD (free, Linux)" in the description of a useful model |
| 11 | **Lemmy** (e.g. 3dprinting / linux communities on lemmy.world) | Small but FOSS-friendly | Similar to Mastodon, light rules. **verify** | Anytime | Same as Mastodon |

## Suggested order

1. Fix blockers (LICENSE, GIF, ideally AppImage).
2. **Mastodon** first (low risk, gentle feedback, find embarrassing bugs).
3. **Thai makers** (Thai text is a unique angle; friendly audience).
4. **r/functionalprint** with a real printed part, then **r/3Dprinting** a few days later.
5. **r/linux**.
6. **Show HN** last, when install is easy and first bugs are fixed — HN traffic
   is one-shot and unforgiving to "npm install fails".

## Track it

Keep a simple list in promo/feedback.md (later): who said what, which channel, what you
changed. Reply "fixed in <commit>" to commenters — that's the best way to get a second comment.
