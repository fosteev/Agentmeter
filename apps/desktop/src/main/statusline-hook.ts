/**
 * Тело хука строки состояния — текстом, а не файлом в ресурсах (1.9).
 *
 * Хук исполняется **вне** приложения: его запускает Claude Code, передавая JSON
 * на stdin. Значит, файл должен лежать по пути, который переживёт и обновление
 * приложения, и переустановку, — то есть рядом с настройками, а не внутри
 * бандла. Ставит его туда `statusline.ts`, а исходник живёт здесь строкой по
 * одной причине: путь, который в разработке и в упакованном приложении разный,
 * — это ровно тот класс ошибки, на котором в 5.1 сломался preload (`..` внутри
 * склеенного пути; окно поднялось и осталось без единого канала). Строка в
 * модуле такого пути не имеет вовсе.
 *
 * Логики в хуке нет намеренно. Он пишет полученное на диск и, если строка
 * состояния была занята чужой командой, прогоняет stdin через неё и отдаёт её
 * вывод дословно. Разбор, дедуп и калибровка — в приложении: вторая
 * реализация в shell разошлась бы с первой на ближайшей правке.
 *
 * Ноды в хуке нет и быть не может: Claude Code ставится нативно, и на машине
 * может не быть ни node, ни jq. Отсюда `sh` и `cmd`.
 *
 * Своя строка — только цифры и латиница: `t()` здесь недоступен, процесс живёт
 * вне приложения и о языке интерфейса не знает.
 */

/** Имя файла хука в каталоге настроек. Windows — `.cmd`, остальные — `.sh`. */
export function hookFileName(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'statusline-hook.cmd' : 'statusline-hook.sh'
}

export function hookBody(platform: NodeJS.Platform): string {
  return platform === 'win32' ? HOOK_CMD : HOOK_SH
}

/**
 * Версия тела хука. Меняется вместе с текстом: приложение переписывает
 * установленный файл, когда он отличается от нынешнего, — иначе обновление
 * приложения оставляло бы на диске хук прошлой версии навсегда.
 */
export const HOOK_VERSION = 1

const HOOK_SH = `#!/bin/sh
# Agentmeter status line hook (v${HOOK_VERSION}).
#
# Installed and removed from the app: Settings -> Limits. All it does is store
# the JSON it receives and call whatever status line command was there before.
# Safe to read or delete by hand; the app survives both.
#
# English on purpose: this script runs outside the app, where t() does not
# exist, and its Windows twin must stay pure ASCII or the console code page
# turns it into garbage.
set -u

dir="\${AGENTMETER_HOME:-}"
if [ -z "$dir" ]; then
  case "$(uname -s)" in
    Darwin) dir="$HOME/Library/Application Support/Agentmeter" ;;
    *) dir="\${XDG_CONFIG_HOME:-$HOME/.config}/agentmeter" ;;
  esac
fi

input=$(cat)

# Whole-file rewrite through a temp file and rename: the hook runs on every
# status line repaint and from several sessions at once, and the app must never
# read half a JSON.
mkdir -p "$dir" 2>/dev/null
tmp="$dir/usage-latest.json.$$"
if printf '%s' "$input" > "$tmp" 2>/dev/null; then
  mv -f "$tmp" "$dir/usage-latest.json" 2>/dev/null || rm -f "$tmp" 2>/dev/null
else
  rm -f "$tmp" 2>/dev/null
fi

# Somebody else's status line command: same stdin, its output passed through
# verbatim, nothing of ours printed on top.
prev="$dir/statusline-prev"
if [ -s "$prev" ]; then
  printf '%s' "$input" | sh -c "$(cat "$prev")"
  exit $?
fi

# Our own line, for when the status line was empty before us. Parsed with sed
# because jq may not be installed; the JSON is flattened first, or sed would
# only ever see one line of it.
flat=$(printf '%s' "$input" | tr -d '\\n')
five=$(printf '%s' "$flat" | sed -n 's/.*"five_hour"[^}]*"used_percentage"[[:space:]]*:[[:space:]]*\\([0-9][0-9.]*\\).*/\\1/p')
seven=$(printf '%s' "$flat" | sed -n 's/.*"seven_day"[^}]*"used_percentage"[[:space:]]*:[[:space:]]*\\([0-9][0-9.]*\\).*/\\1/p')

# There is no rate_limits key at all until the first API request of the session
# has gone through. Nothing to print then, and that is not an error.
[ -n "$five" ] || exit 0
line="5h \${five%%.*}%"
[ -n "$seven" ] && line="$line / 7d \${seven%%.*}%"
printf '%s\\n' "$line"
`

const HOOK_CMD = `@echo off
rem Agentmeter status line hook (v${HOOK_VERSION}).
rem
rem Installed and removed from the app: Settings -> Limits. All it does is store
rem the JSON it receives and call whatever status line command was there before.
rem Pure ASCII on purpose: the console code page would mangle anything else.
setlocal
set "AM_DIR=%AGENTMETER_HOME%"
if not defined AM_DIR set "AM_DIR=%APPDATA%\\Agentmeter"
if not exist "%AM_DIR%" mkdir "%AM_DIR%" >nul 2>&1

rem Whole-file rewrite through a temp file and move: the hook runs on every
rem status line repaint and from several sessions at once.
set "AM_TMP=%AM_DIR%\\usage-latest.json.%RANDOM%"
more > "%AM_TMP%"
move /y "%AM_TMP%" "%AM_DIR%\\usage-latest.json" >nul 2>&1

if not exist "%AM_DIR%\\statusline-prev" goto own
set /p AM_PREV=<"%AM_DIR%\\statusline-prev"
type "%AM_DIR%\\usage-latest.json" | cmd /c %AM_PREV%
exit /b

:own
rem Parsed with PowerShell: cmd cannot read JSON by any sane means, and node may
rem not be installed at all.
powershell -NoProfile -ExecutionPolicy Bypass -Command "$p = Join-Path $env:AM_DIR 'usage-latest.json'; if (Test-Path -LiteralPath $p) { $r = (Get-Content -Raw -LiteralPath $p | ConvertFrom-Json).rate_limits; if ($r -and $r.five_hour) { $s = '5h ' + [int]$r.five_hour.used_percentage + '%%'; if ($r.seven_day) { $s = $s + ' / 7d ' + [int]$r.seven_day.used_percentage + '%%' }; Write-Output $s } }"
exit /b
`
