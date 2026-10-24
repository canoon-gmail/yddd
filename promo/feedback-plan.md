# Feedback plan — the first ~20 users

Goal: learn what stops new users, and what they really want to print. Not stats — real words.

## Questions we most want answered

1. **Did it start?** OS / distro, did install and first launch work. (Win / macOS builds are next.)
2. **What did you try to make?** Real parts tell us which tools matter.
3. **Where did you get stuck in the first 10 minutes?** The biggest one.
4. **Did you finish a part and print it?** Did the STL / 3MF go into the slicer fine (Bambu Studio, PrusaSlicer, Cura)?
5. **What could you not make at all?** The missing tool.
6. **What do you use now?** (Tinkercad, FreeCAD, Fusion 360, OpenSCAD ...) — what is better / worse here.
7. **Would you use it again?** If not, why not.

Watch for: keys / mouse that feel wrong, words in panels that are not clear, crashes or wrong shapes (fillet, sweep, boolean).

## How to collect

| Way | For | Status |
|---|---|---|
| Issue template **First impressions** | Q2, Q3, Q7 — 3 short questions | `.github/ISSUE_TEMPLATE/first_impressions.yml` |
| Issue template **Bug report** | Q1, crashes, wrong shapes (asks for OS, version, steps, `.yddd` file) | `bug_report.yml` |
| Issue template **Feature request** | Q5, Q6 — starts from the part, not the tool | `feature_request.yml` |
| **Discussions**, pinned welcome post | Q2, Q4, people who do not want to "file an issue" | `promo/discussions-welcome.md` |
| Ask directly | When someone posts a print / comment anywhere (Reddit, forums), ask the 3 first-impression questions in a reply | by hand |

Setup on GitHub (by hand, when ready):
- Settings → Features → tick **Discussions**; make the categories in `discussions-welcome.md`; post and pin the welcome.
- Create labels `bug`, `enhancement` (exist by default) and `first-impressions` — a label that does not exist is just not added.
- Commit `.github/ISSUE_TEMPLATE/` to master.
- Add one line to README: "Tried it? Tell us how it went → First impressions / Discussions" with links.

## Optional: Help → Send feedback (describe only, not built)

A menu item at the end of the Help menu (`src/main/main.ts`, the `&Help` submenu):

- **Help → Send Feedback…** opens the browser with `shell.openExternal(...)` on
  `https://github.com/canoon-gmail/yddd/issues/new?template=first_impressions.yml`
- Maybe also **Help → Report a Bug…** → `...?template=bug_report.yml&os=<os>&version=<version>`
  — issue forms can be pre-filled by field id in the URL (`os`, `version` are the ids in `bug_report.yml`), so the app can fill in `process.platform` / `os.release()` and `app.getVersion()` itself. URL-encode the values.
- No data sent by the app itself, no account needed in the app — the user sees the form in the browser and can change or not send it.
- Needs a GitHub account; for people without one, the Discussions link or an email is the fallback (maybe a second line in the same menu).

## After 20 users

- Read everything once, write the top 5 problems and top 5 wanted parts in a short list.
- Fix the biggest "stuck in 10 minutes" problem first, before new features.
- Reply to every post — first users who get an answer come back.
