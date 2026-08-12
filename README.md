# Agentmeter

A token meter for coding agents — Claude Code and Codex. It lives in the tray and
shows who is working right now, how much is left before a limit, and where the
day went. Everything is computed from the logs already on your disk.

It was written to answer one question: **what your setup costs when you are not
using it.** An MCP server you never call still loads into every session and is
re-read on every request — on real logs, 19 servers out of 22 turned out to be
never called, and they cost 11.4M tokens.

![The day, task by task](docs/screenshots/en/today.png)

## What it shows

- **Who is working right now** — agent, project, state (thinking, waiting for
  you, silent), pace in tokens per minute, context window left.
- **Limits** — the 5-hour and weekly windows, one tab per provider. The popup
  opens on the most alarming one, and the tab left behind keeps a dot in the
  colour of its own worst window. Codex percentages are exact; Claude's carry
  `≈` (see [What it does not know](#what-it-does-not-know--and-says-so)).
- **The whole day** — a feed of tasks with an expandable card: request timeline,
  token kinds, tools, files touched, subagents. Plus breakdowns by hour, project
  and ticket. Running sessions are pinned to the top of the feed with the
  request they are on and what the turn has cost so far.
- **Where the spend went** — what sits in the prompt before your first word
  versus what the agent actually called, with advice like “the jira server was
  never called across 34 sessions; turning it off returns 194.7k”.
- **History** — a week, 30 days or all time, with a day × hour heatmap.

The popup is 400 × 600, right under the tray icon; its header carries the age of
the snapshot and a button that rebuilds it — `⌘R` does the same.

<img src="docs/screenshots/en/popup.png" alt="Tray popup" width="380">

![Spend breakdown](docs/screenshots/en/breakdown.png)

English and Russian, following the system language. The same screens in Russian
are in [`docs/screenshots/ru/`](docs/screenshots/ru/).

## Install

Builds live on the
[releases page](https://github.com/fosteev/Agentmeter/releases). **They are not
signed** — signing is a separate stage and the project has no certificates yet,
so each platform warns you once.

### macOS

There are two `.dmg` files and the difference matters:

| file                             | for                          |
| -------------------------------- | ---------------------------- |
| `Agentmeter-<version>-arm64.dmg` | Apple Silicon — M1 and later |
| `Agentmeter-<version>.dmg`       | Intel                        |

The unsuffixed one is the Intel build. On an Apple Silicon Mac it either runs
slowly under Rosetta or, without Rosetta, does not start at all — and it fails
quietly, which reads like a broken download. Apple menu → About This Mac says
which chip you have.

1. Open the `.dmg` and drag **Agentmeter** onto the **Applications** shortcut in
   the same window.
2. Clear the quarantine flag, once:

   ```bash
   xattr -dr com.apple.quarantine /Applications/Agentmeter.app
   ```

3. Launch it. The icon appears in the menu bar — there is no dock icon until you
   open the window from it.

Without step 2 macOS says it “could not verify Agentmeter is free of malware”.
That is the missing signature talking, not a finding — there was nothing to
find, and nothing to check it with. The same thing through the interface:
System Settings → Privacy & Security → **Open Anyway**, at the bottom, after the
first refusal. **Right-click → Open no longer works**; Apple removed that path
for unsigned apps in macOS 26.

If the drag itself does nothing:

- an older copy is still running — quit it from the menu bar icon first. Finder
  refuses to replace a running app and says little about it;
- or skip Finder and copy it from a terminal — the volume name is the one shown
  in the Finder sidebar:

  ```bash
  cp -R "/Volumes/Agentmeter <version>-arm64/Agentmeter.app" /Applications/
  ```

To remove: drag the app to the Trash and delete
`~/Library/Application Support/Agentmeter`, where the index and settings live.

### Windows

Run `Agentmeter-Setup-<version>.exe`. SmartScreen → “More info” → “Run anyway”.

### Linux

`chmod +x` the `.AppImage`, or `sudo dpkg -i` the `.deb`.

## What it does with your data

Nothing leaves your machine unless you ask it to. Logs are read from disk,
parsed locally and kept in a SQLite index inside the app's config directory.

**There are exactly three network calls, and every one of them is a switch you
control.**

1. **The update check** — every six hours, against this repository's releases.
   On by default, turned off in Settings → Application.
2. **Asking Anthropic for your limit percentages** — **off by default**,
   Settings → Limits. It reads the token Claude Code already stored
   (`~/.claude/.credentials.json` or the macOS keychain) and asks
   `api.anthropic.com` how much of your 5-hour and weekly windows you have used,
   at most once every fifteen minutes.
3. **Asking OpenAI the same about Codex** — also **off by default**, same place,
   same pace, using the token in `~/.codex/auth.json`.

None of the three sends anything else, and none writes anything back: the app
never refreshes or rewrites your credentials, and tokens are never logged or
shown on screen.

The second call exists because Claude does not write the limit percentage into
its logs at all. The status line hook (Settings → Limits) gets it without any
network — but the status line only exists in the terminal, so in VS Code and
other editors there is nothing to hook.

The third exists because Codex logs an exact percentage stamped at the moment of
the request: after a day away it describes the window before last, and a limit
counts per account, so work from the web or another machine never reaches your
logs. The call refreshes the age of a number you already have.

Two privacy switches sit alongside: “hide prompt texts” and “hide file paths”.
Both remove data from the app's response, not from the markup — a hidden prompt
never travels to the window at all.

## What it does not know — and says so

This is a measuring instrument, so anything unmeasured is marked rather than
smoothed over. Everything that is an estimate carries an `≈`.

- **Some API requests are never written to the transcript.** They are
  reconstructed from the break in the cache chain; what remains are trailing
  warm-ups after the last answer, which leave no trace at all. The gap is
  ≤ 3.3% and always downward.
- **The weight of a cache-read token against the Claude subscription limit is
  unknown.** Counting it or ignoring it differs by two orders of magnitude, so
  Claude percentages stay estimates until the weight is calibrated. It is not
  guessed and not typed in: the weight and the window cap are solved together
  from the percentages Claude itself reports. Codex percentages come from the
  server and are exact.
- **Claude's housekeeping Haiku calls** (session titles, “while you were away”
  summaries) are absent from transcripts entirely. Against Claude Code's own
  numbers that is 1.3% overall — but up to 30% on small projects, because the
  cost is per session rather than per token. Putting a number on them would mean
  inventing a coefficient.
- **Claude Code deletes its own transcripts** (`cleanupPeriodDays`, 30 days by
  default). The index outlives them and forgets nothing, but days *before* the
  oldest surviving log show a lower bound with `≈`, and days with no records at
  all read “no data” rather than “no work”.
- **Claude does not log its context window size.** It is inferred from
  observations and marked as an estimate; Codex reports it on every request.

![History](docs/screenshots/en/history.png)

## Command line

The same numbers without the graphics, on top of the same core:

```bash
agentmeter today                     # day total, breakdowns, limits
agentmeter tasks --day 2026-08-10    # task feed
agentmeter breakdown --by server     # breakdown: tools, MCP, skills
agentmeter limits                    # limit windows
agentmeter doctor                    # what was read, what was not understood
agentmeter export --grain task       # export to CSV or JSON
```

## Building from source

Node 22.12 or newer.

```bash
npm ci
npm run check                                  # lint, build, tests
npm run -w @agentmeter/desktop start           # run from the tray
npm run -w @agentmeter/desktop package         # build the installers
```

There are no native modules: SQLite comes from `node:sqlite`, which ships inside
Electron itself — so `electron-rebuild` is not needed and never runs.

## How it is put together

The core (`packages/core`) knows nothing about Electron: log parsing, the index,
attribution, limits and the screen aggregates all live there, and the CLI and
the app are two consumers of it. That way the numbers can be checked in a
terminal without starting a GUI.

What is in the logs, how the spend is computed and why — in
[`docs/plan.md`](docs/plan.md) and [`CLAUDE.md`](CLAUDE.md) (both in Russian).
Milestones and status live in [`docs/roadmap.md`](docs/roadmap.md).

## License

MIT — [`LICENSE`](LICENSE).
