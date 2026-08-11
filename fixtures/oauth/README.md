# fixtures/oauth — ответ `/api/oauth/usage` (6.3)

Три файла: один снят живым, два дописаны руками под случаи, которых на
замеренном аккаунте не случилось.

## `usage-live.json`

Живой ответ, 11 августа 2026, 19:55 UTC. HTTP 200, `request-id:
req_011CdwYnzndBYvpKo8sJNoy2`, аккаунт Max. Тело сохранено дословно — включая
поля, смысла которых мы не знаем.

| что видно                                   | значение                                    |
| ------------------------------------------- | ------------------------------------------- |
| `five_hour.utilization`                     | `0.0` — окно сброшено в 19:40, за 15 минут до снимка |
| `seven_day.utilization`                     | `19.0`                                      |
| `limits[]`                                  | `session` 0, `weekly_all` 19, `weekly_scoped` 0 (Fable, `is_active: false`) |
| `spend.enabled` / `extra_usage.is_enabled`  | `false` / `false` — денег сверх подписки нет |
| кодовые имена                               | `tangelo`, `iguana_necktie`, `omelette_promotional`, `cinder_cove`, `amber_ladder` — все `null`; `nimbus_quill` — ноль с `resets_at: null` |

**Проценты целые.** `0.0` и `19.0` — не округление при печати, а формат
источника: в массиве `limits` те же числа лежат как `percent: 0` и `percent: 19`,
целыми. Отсюда порог `minIntegerPct` в калибровке — см.
[`6.3-oauth-usage.md`](../../docs/roadmap/6.3-oauth-usage.md), раздел «Точность».

Сверено с `cachedUsageUtilization` из `~/.claude.json` того же дня: **то же
тело**, поле в поле, вместе с кодовыми именами. Различие одно — возраст. В файле
`fetchedAtMs` показывал 3.5 часа в момент, когда сам файл был переписан минутой
раньше; ответ на запрос свеж всегда.

Заголовков ограничения при 200 нет вовсе: ни `Retry-After`, ни `ratelimit-*`.

## `usage-models.json`

Дописан руками из живого: `five_hour` 64%, `weekly_all` 41%, ненулевые
`seven_day_opus` (73%) и `seven_day_sonnet` (12%), активный `weekly_scoped` на
Opus. Проверяет ровно одно: разбор берёт `session` и `weekly_all`, а модельные
окна **пропускает молча** — не роняет ответ и не подмешивает их в журнал.
Вторая запись `weekly_scoped` (Fable, `resets_at: null`) стоит здесь же:
окно без границы в модель 1.9 не входит, ей нужен интервал.

## `credentials-keychain.json`

Форма вывода `security find-generic-password -s "Claude Code-credentials" -w`.
Токены — заведомые заглушки с `FIXTURE-NOT-A-REAL-TOKEN` внутри; проверяется
разбор структуры, а не значение. Важна тут ветка `claudeAiOauth.accessToken`:
на замеренной машине `~/.claude/.credentials.json` не существует вовсе, всё
лежит в Keychain, — то есть это основной путь, а не запасной.
