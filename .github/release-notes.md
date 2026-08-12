A token meter for coding agents — Claude Code and Codex — living in the tray.

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

- **macOS**: right-click the app → “Open” → “Open”, or once in a terminal:
  `xattr -dr com.apple.quarantine /Applications/Agentmeter.app`
- **Windows**: SmartScreen → “More info” → “Run anyway”.
- **Linux**: `chmod +x` for the `.AppImage`.

On macOS the menu bar icon is drawn by a small native helper: on macOS 26 the
Electron tray item is parked off-screen by the system, and every Electron app on
such a machine loses its icon silently.
