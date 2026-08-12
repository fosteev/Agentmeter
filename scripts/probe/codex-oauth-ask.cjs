/**
 * Один запрос к `wham/usage` тем же стеком, каким ходит приложение (6.4).
 *
 * Запускается под Electron из `codex-oauth-live.ts --live` и печатает в stdout
 * одну строку JSON: `{ status, retryAfter, body }`. Отдельным файлом, а не
 * куском пробы, ровно потому, что стек другой: из Node этот запрос получает
 * 403 html-страницей блокировки — перед `chatgpt.com/backend-api` стоит
 * Cloudflare, и отсекает он по отпечатку TLS. Проба, ходящая не тем стеком,
 * что приложение, проверяет не то.
 *
 * Токен читается тем же способом, что в приложении, и наружу не печатается.
 * Рефреша здесь нет и быть не должно — см. шапку `main/codex-oauth.ts`.
 */
const { app, net } = require('electron')
const { readFileSync } = require('node:fs')
const { homedir } = require('node:os')
const { join } = require('node:path')

function credentials() {
  try {
    const raw = readFileSync(join(homedir(), '.codex', 'auth.json'), 'utf8')
    const parsed = JSON.parse(raw)
    const token = parsed?.tokens?.access_token
    if (typeof token !== 'string' || token === '') return undefined
    return { token, accountId: parsed?.tokens?.account_id }
  } catch {
    return undefined
  }
}

app.whenReady().then(async () => {
  const found = credentials()
  if (!found) {
    console.log(JSON.stringify({ error: 'no-credentials' }))
    app.exit(0)
    return
  }
  try {
    const headers = {
      authorization: `Bearer ${found.token}`,
      accept: 'application/json',
      'user-agent': 'Agentmeter',
    }
    if (found.accountId) headers['chatgpt-account-id'] = found.accountId
    const response = await net.fetch('https://chatgpt.com/backend-api/wham/usage', { headers })
    const out = { status: response.status, retryAfter: response.headers.get('retry-after') }
    if (response.ok) out.body = await response.json()
    console.log(JSON.stringify(out))
  } catch (error) {
    console.log(JSON.stringify({ error: String(error?.message ?? error) }))
  }
  app.exit(0)
})
