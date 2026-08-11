A token meter for coding agents — Claude Code and Codex — living in the tray.

## What it shows

- **Who is working right now** — agent, project, state, pace in tokens per
  minute, and how much of the context window is left.
- **Limits** — the 5-hour and weekly windows. Codex reports exact percentages;
  Claude's are marked `≈` until calibration has enough observations.
- **The whole day** — a feed of tasks with an expandable card: request
  timeline, token kinds, tools, files touched, subagents. Running sessions are
  pinned to the top with what they are working on right now.
- **Where the spend went** — what sits in the prompt before your first word
  versus what the agent actually called, with advice like “this server was
  never called across 34 sessions; turning it off returns 194.7k”.
- **History** — a week, 30 days or all time, with a day × hour heatmap.

English and Russian, following the system language.

## What it does with your data

Everything is computed from the logs already on your disk. The only network
call is the update check, every six hours against this repository's releases —
it can be turned off in Settings → Application.

## Installing

The builds are **not signed** — the project has no certificates yet.

- **macOS**: right-click the app → “Open” → “Open”, or once in a terminal:
  `xattr -dr com.apple.quarantine /Applications/Agentmeter.app`
- **Windows**: SmartScreen → “More info” → “Run anyway”.
- **Linux**: `chmod +x` for the `.AppImage`.

On macOS the menu bar icon is drawn by a small native helper: on macOS 26 the
Electron tray item is parked off-screen by the system, and every Electron app on
such a machine loses its icon silently.
