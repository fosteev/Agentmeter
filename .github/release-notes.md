A token meter for coding agents — Claude Code and Codex — living in the tray.

## In this release

- **Windows: the app now starts at all.** It never did — not in any build since
  the first release. SQLite does not create the folder its database lives in,
  and nothing else created it either: on macOS the app got away with it because
  Electron makes a folder of its own whose name differs only in case, and the
  filesystem there does not care. On Windows those are two different places, so
  every first launch failed — and failed invisibly: the process stayed alive
  with no window, no tray icon and no exit code, which reads as “nothing
  happened”. The folder is created now, and a start that fails says so in a
  dialog instead of hanging.
- **Windows: the popup no longer scrolls inside itself.** A frameless window
  there hands the page one point less than asked for, and the popup frame was a
  fixed 400 points wide — one point too many. That was enough to raise both
  scrollbars: they take up space on Windows, so the horizontal one ate the
  height and the vertical one appeared under it, leaving 384 points of the 399.
  The frame now takes its width from the window.

## In 0.4.1

- **The popup opens on the desktop you are looking at.** On macOS it always
  claimed every Space — and quietly lost them. Hiding a window unloads it from
  the window server, which then pins it to the Spaces it remembered; when any of
  those dies (an app leaving full screen), the hidden popup is moved back to
  desktop one, and the next click on the menu bar icon opens it there instead of
  where you are. A popup a day old had one Space out of thirteen while every
  flag still read “visible on all workspaces”. It now closes by going
  transparent instead of hiding.

## In 0.4.0

- **An AI brief in the export menu.** A markdown file you can hand to any LLM
  to get token-saving advice: the same numbers the screens show, plus the
  measured reading rules — without them an outside model happily suggests
  things this project has already disproven. Also `agentmeter brief` in the
  CLI (`--json` gives the same data as an object).
- **Notifications on macOS actually arrive now.** The bundle was not sealed,
  and the system refused every notification silently — for four months this
  looked like “notifications just don't come”. Packaging now seals the bundle
  (ad-hoc: still no certificates, see below).
- **Clicking a notification returns you to work**, not to the token meter: it
  opens the app the agent runs in — VS Code, the terminal — where that app is
  known; elsewhere it opens Agentmeter's window as before.
- **The Limits settings lost what never worked** — the ceiling cards with
  nothing to measure and the status-line hook that produced zero observations
  in a month. In their place: checkboxes for which windows the popup shows. An
  installed hook is removed from Claude's settings on startup.
- **History longer than a week scrolls sideways** instead of crushing its own
  labels; picking a day no longer dims the screen, and its breakdown opens
  with a button. The breakdown filter now reaches the right column too.

## What it shows

- **Who is working right now** — agent, project, pace in tokens per minute, and
  how much of the context window is left. Only agents actually working: chats
  waiting for you sit in the day's feed, not in that list.
- **Limits** — the 5-hour, weekly and monthly windows, split into provider tabs;
  the popup opens on the most alarming one. Codex reports exact percentages;
  Claude's are marked `≈` until calibration has enough observations, unless you
  let the app ask Anthropic directly (off by default, see below).
- **The whole day** — a feed of tasks with an expandable card: request
  timeline, token kinds, tools, files touched, subagents. Running sessions are
  pinned to the top with what they are working on right now.
- **Where the spend went** — what sits in the prompt before your first word
  versus what the agent actually called, with advice like “this server was
  never called across 34 sessions; turning it off returns 194.7k”.
- **History** — a week, 30 days or all time, with a day × hour heatmap.
- **Export** — the day's tasks as CSV/JSON, or an AI brief: a markdown file to
  feed an LLM for savings advice grounded in the measured rules.

English and Russian, following the system language.

## What it does with your data

Everything is computed from the logs already on your disk. The app makes three
network calls in total, and every one of them has its own switch:

- the update check, every six hours against this repository's releases;
- asking Anthropic for the real limit percentages of the account you are
  already signed into — **off by default**;
- the same for OpenAI — **off by default**.

Both limit sources reuse the token the CLI has already stored on your machine,
read-only: nothing is sent anywhere else, and no token is ever refreshed or
rewritten.

## Installing

The builds are **not signed** — the project has no certificates yet.

- **macOS**: take the `.dmg` for your chip — `-arm64` for Apple Silicon, `-x64`
  for Intel; the wrong one runs under Rosetta at best and does not start at all
  without it. Drag the app into Applications, then run once in a terminal:
  `xattr -dr com.apple.quarantine /Applications/Agentmeter.app`

  Without it macOS says it “could not verify Agentmeter is free of malware” —
  that is the missing signature talking, not a finding. The GUI route is System
  Settings → Privacy & Security → “Open Anyway” at the bottom, after the first
  refusal. Right-click → “Open” no longer works on macOS 26; Apple removed that
  path for unsigned apps. If Finder refuses to replace an older copy, quit the
  running one from the menu bar icon first.
- **Windows**: SmartScreen → “More info” → “Run anyway”.
- **Linux**: `chmod +x` for the `.AppImage`, or `sudo dpkg -i` the `.deb`.

On macOS the menu bar icon is drawn by a small native helper: on macOS 26 the
Electron tray item is parked off-screen by the system, and every Electron app on
such a machine loses its icon silently.
