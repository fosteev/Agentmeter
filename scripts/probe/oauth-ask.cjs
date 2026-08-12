/**
 * Один запрос к `/api/oauth/usage` тем же стеком, каким ходит приложение (6.3).
 *
 * Запускается под Electron из `oauth-live.ts --live` и печатает в stdout одну
 * строку JSON: `{ status, retryAfter, body }`. Отдельным файлом, а не куском
 * пробы, ровно потому, что стек другой: из Node этот запрос получает 403 —
 * Cloudflare отсекает его по отпечатку TLS (замер в брифе). Проба, ходящая не
 * тем стеком, что приложение, проверяет не то.
 *
 * Токен читается тем же кодом, что в приложении, и наружу не печатается.
 */
const { app, net } = require('electron')
const { execFileSync } = require('node:child_process')
const { readFileSync } = require('node:fs')
const { homedir } = require('node:os')
const { join } = require('node:path')

function token() {
  try {
    const raw = readFileSync(join(homedir(), '.claude', '.credentials.json'), 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed?.claudeAiOauth?.accessToken) return parsed.claudeAiOauth.accessToken
  } catch {
    // Файла нет — на macOS это обычное дело, всё лежит в связке ключей.
  }
  if (process.platform !== 'darwin') return undefined
  try {
    const raw = execFileSync(
      '/usr/bin/security',
      ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
      { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] },
    )
    return JSON.parse(raw)?.claudeAiOauth?.accessToken
  } catch {
    return undefined
  }
}

app.whenReady().then(async () => {
  const access = token()
  if (!access) {
    console.log(JSON.stringify({ error: 'no-credentials' }))
    app.exit(0)
    return
  }
  try {
    const response = await net.fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: {
        authorization: `Bearer ${access}`,
        accept: 'application/json',
        'anthropic-beta': 'oauth-2025-04-20',
        'user-agent': 'Agentmeter',
      },
    })
    const out = { status: response.status, retryAfter: response.headers.get('retry-after') }
    if (response.ok) out.body = await response.json()
    console.log(JSON.stringify(out))
  } catch (error) {
    console.log(JSON.stringify({ error: String(error?.message ?? error) }))
  }
  app.exit(0)
})
