#!/usr/bin/env python3
"""Сверка подсчёта расхода с эталоном самого Claude Code.

Claude Code пишет итоги последней сессии каждого проекта в ~/.claude.json:
lastTotal*Tokens и lastModelUsage с разбивкой по моделям. Это независимый
источник правды — цифры посчитаны не нами и не из нашей арифметики.

Зародыш этапа 1.3 (docs/roadmap/1.3-verify.md). На момент написания сверка
НЕ СХОДИТСЯ: недобор 5-15% по чтению кэша на всех проверенных сессиях.
Причина не установлена. Гипотеза про usage.iterations проверена и отпала.
"""
import json
import os
import glob


def sum_transcript(path):
    """Наивная агрегация: дедуп по requestId, берём usage первой строки.

    Одна строка assistant на блок контента, usage в них продублирован —
    поэтому суммировать построчно нельзя. Но и этот вариант недобирает,
    что и есть предмет расследования.
    """
    seen = set()
    t = {'in': 0, 'out': 0, 'cw': 0, 'cr': 0}
    for line in open(path, errors='replace'):
        try:
            r = json.loads(line)
        except ValueError:
            continue
        if r.get('type') != 'assistant':
            continue
        rid = r.get('requestId')
        if rid in seen:
            continue
        seen.add(rid)
        u = r['message']['usage']
        t['in'] += u.get('input_tokens', 0)
        t['out'] += u.get('output_tokens', 0)
        t['cw'] += u.get('cache_creation_input_tokens', 0)
        t['cr'] += u.get('cache_read_input_tokens', 0)
    return t, len(seen)


def main():
    cfg = json.load(open(os.path.expanduser('~/.claude.json')))
    files = {os.path.basename(p)[:-6]: p
             for p in glob.glob(os.path.expanduser('~/.claude/projects/*/*.jsonl'))}

    ok = bad = missing = 0
    for name, proj in cfg.get('projects', {}).items():
        sid = proj.get('lastSessionId')
        if not sid or not (proj.get('lastTotalCacheReadInputTokens') or 0):
            continue
        path = files.get(sid)
        if not path:
            missing += 1
            continue

        got_d, reqs = sum_transcript(path)
        got = (got_d['in'], got_d['out'], got_d['cw'], got_d['cr'])
        want = (proj.get('lastTotalInputTokens'), proj.get('lastTotalOutputTokens'),
                proj.get('lastTotalCacheCreationInputTokens'),
                proj.get('lastTotalCacheReadInputTokens'))

        if got == want:
            ok += 1
            continue
        bad += 1
        print(f"\n{os.path.basename(name)}  ({reqs} запросов)")
        print(f"  эталон  in={want[0]:<8} out={want[1]:<8} cw={want[2]:<9} cr={want[3]}")
        print(f"  наше    in={got[0]:<8} out={got[1]:<8} cw={got[2]:<9} cr={got[3]}")
        if want[3]:
            print(f"  недобор cr: {(got[3] - want[3]) / want[3] * 100:+.2f}%")
        # разбивка по моделям показывает, чей это класс запросов
        for model, u in (proj.get('lastModelUsage') or {}).items():
            print(f"    {model:32} in={u.get('inputTokens'):<7} out={u.get('outputTokens'):<7}"
                  f" cr={u.get('cacheReadInputTokens')}")

    print(f"\nсошлось {ok}, разошлось {bad}, файл сессии не найден {missing}")
    return 0 if bad == 0 else 1


if __name__ == '__main__':
    raise SystemExit(main())
