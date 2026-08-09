#!/bin/zsh
# Стенд калибровки стартового префикса (1.7).
#
# Способ — «весы»: известный текст кладётся в CLAUDE.md пустой папки, гоняется
# `claude -p 'hi' --model haiku`, разница ctx даёт точное число токенов без
# всякого токенизатора. Прогон стоит около цента, весь стенд — около двадцати.
#
# Единственный скрипт в проекте, который ходит в сеть и тратит лимит. Запускать
# руками и редко: когда вышла новая версия CLI и остаток `system` поехал.
# Полученные числа переносятся в packages/core/src/attribution/calibration.ts
# и в fixtures/prefix/README.md — руками, с датой и версией CLI.
#
#   zsh scripts/probe/calibrate-prefix.sh [путь-к-транскрипту.jsonl]
#
# Транскрипт нужен, чтобы взять из него дословный текст листингов скиллов,
# сабагентов, имён отложенных тулов и инструкций MCP. Без аргумента берётся
# самый свежий из ~/.claude/projects.
set -u

WORK=$(mktemp -d)
BENCH="$WORK/bench"
BLOCKS="$WORK/blocks"
mkdir -p "$BENCH" "$BLOCKS"
trap 'rm -rf "$WORK"' EXIT

# В PATH может лежать несколько установок; homebrew заметно отстаёт от нативной.
# Числа стенда привязаны к версии, поэтому берём самую свежую и печатаем её.
CLAUDE=$(command -v claude)
for candidate in "$HOME/.local/bin/claude" /opt/homebrew/bin/claude; do
  [[ -x $candidate ]] || continue
  newest=$(printf '%s\n%s\n' "$("$candidate" --version 2>/dev/null | cut -d' ' -f1)" \
                             "$("$CLAUDE" --version 2>/dev/null | cut -d' ' -f1)" |
           sort -V | tail -1)
  [[ $("$candidate" --version 2>/dev/null | cut -d' ' -f1) == "$newest" ]] && CLAUDE=$candidate
done
echo "версия CLI: $("$CLAUDE" --version 2>/dev/null)  ($CLAUDE)"

NOMCP=(--strict-mcp-config --mcp-config '{"mcpServers":{}}')
SERENA='{"mcpServers":{"serena":{"type":"stdio","command":"serena","args":["start-mcp-server","--context","claude-code","--project-from-cwd"],"env":{}}}}'

# ctx первого (и единственного) запроса: input + cacheWrite + cacheRead.
# jq тут не годится — в поле result приезжают сырые управляющие символы, и
# собственный json CLI на них разваливается. Разбираем нодой, терпимо к мусору.
ctx() {
  "$CLAUDE" -p 'hi' --model haiku --no-session-persistence --output-format json "$@" 2>/dev/null |
    tail -1 |
    node -e '
      let s = "";
      process.stdin.on("data", (c) => (s += c)).on("end", () => {
        const g = (k) => Number((s.match(new RegExp(`"${k}":(\\d+)`)) ?? [0, 0])[1]);
        console.log(g("input_tokens") + g("cache_creation_input_tokens") + g("cache_read_input_tokens"));
      });
    '
}

run() { printf '%-30s %s\n' "$1" "$(shift; ctx "$@")" }

cd "$BENCH" || exit 1

echo "\n── база и крупные блоки ──"
run 'база (ни тулов, ни MCP)'  --tools ""      "${NOMCP[@]}" --disable-slash-commands
run 'схемы вшитых тулов'       --tools default "${NOMCP[@]}" --disable-slash-commands

echo "\n── схемы отдельных тулов (аддитивны до токена) ──"
for t in Bash Read Edit Write Agent Skill ToolSearch WebFetch Bash,Read; do
  run "  $t"                   --tools "$t"    "${NOMCP[@]}" --disable-slash-commands
done

echo "\n── MCP: жадно против отложенно ──"
run 'Bash + serena, жадно'      --tools Bash            --strict-mcp-config --mcp-config "$SERENA" --disable-slash-commands
run 'Bash,ToolSearch + serena'  --tools Bash,ToolSearch --strict-mcp-config --mcp-config "$SERENA" --disable-slash-commands
run 'default + serena'          --tools default         --strict-mcp-config --mcp-config "$SERENA" --disable-slash-commands

echo "\n── весы: байт на токен по категориям ──"
SRC=${1:-$(ls -t ~/.claude/projects/*/*.jsonl 2>/dev/null | head -1)}
echo "источник текстов: $SRC"
node -e '
  const { readFileSync, writeFileSync } = require("node:fs");
  const [src, out] = process.argv.slice(1);
  const blocks = {};
  for (const line of readFileSync(src, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let r; try { r = JSON.parse(line) } catch { continue }
    const a = r.type === "attachment" ? r.attachment : null;
    if (!a) continue;
    if (a.type === "skill_listing" && !blocks.skills) blocks.skills = a.content ?? "";
    if (a.type === "agent_listing_delta" && !blocks.agents) blocks.agents = (a.addedLines ?? []).join("\n");
    if (a.type === "deferred_tools_delta" && !blocks.deferred) blocks.deferred = (a.addedNames ?? []).join("\n");
    if (a.type === "mcp_instructions_delta" && !blocks.mcpInstr) blocks.mcpInstr = (a.addedBlocks ?? []).join("\n\n");
  }
  for (const [k, v] of Object.entries(blocks)) writeFileSync(`${out}/${k}.txt`, v);
' "$SRC" "$BLOCKS"

printf 'x' > CLAUDE.md
EMPTY=$(ctx --tools "" "${NOMCP[@]}" --disable-slash-commands)
echo "  пустой CLAUDE.md: ctx=$EMPTY (обёртка файла)"
for b in deferred mcpInstr skills agents; do
  [[ -f "$BLOCKS/$b.txt" ]] || continue
  cp "$BLOCKS/$b.txt" CLAUDE.md
  BYTES=$(wc -c < CLAUDE.md | tr -d ' ')
  C=$(ctx --tools "" "${NOMCP[@]}" --disable-slash-commands)
  printf '  %-10s байт=%-7s ctx=%-7s токенов=%-6s б/т=%s\n' \
    "$b" "$BYTES" "$C" "$((C - EMPTY))" "$(node -e "console.log(($BYTES/($C-$EMPTY)).toFixed(2))")"
done

# Проза и первый ход пользователя: берём собственный CLAUDE.md двумя размерами,
# наклон по двум точкам честнее одной — в одной сидит обёртка файла.
if [[ -f ~/.claude/CLAUDE.md ]]; then
  cp ~/.claude/CLAUDE.md CLAUDE.md
  B1=$(wc -c < CLAUDE.md | tr -d ' '); C1=$(ctx --tools "" "${NOMCP[@]}" --disable-slash-commands)
  for i in 1 2 3; do cat ~/.claude/CLAUDE.md >> CLAUDE.md; done
  B4=$(wc -c < CLAUDE.md | tr -d ' '); C4=$(ctx --tools "" "${NOMCP[@]}" --disable-slash-commands)
  printf '  %-10s байт=%-7s→%-7s ctx=%-7s→%-7s б/т по наклону=%s\n' \
    'проза' "$B1" "$B4" "$C1" "$C4" "$(node -e "console.log((($B4-$B1)/($C4-$C1)).toFixed(2))")"
fi
rm -f CLAUDE.md
