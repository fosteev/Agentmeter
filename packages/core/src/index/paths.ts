import { homedir, platform } from 'node:os'
import { join } from 'node:path'

export function defaultClaudeHome(): string {
  return join(homedir(), '.claude')
}

export function defaultCodexHome(): string {
  return join(homedir(), '.codex')
}

export function defaultIndexPath(): string {
  const override = process.env['AGENTMETER_INDEX']
  if (override) return override

  const home = homedir()
  switch (platform()) {
    case 'darwin':
      return join(home, 'Library', 'Application Support', 'agentmeter', 'index.sqlite')
    case 'win32':
      return join(
        process.env['LOCALAPPDATA'] ?? join(home, 'AppData', 'Local'),
        'agentmeter',
        'index.sqlite',
      )
    default:
      return join(
        process.env['XDG_DATA_HOME'] ?? join(home, '.local', 'share'),
        'agentmeter',
        'index.sqlite',
      )
  }
}
