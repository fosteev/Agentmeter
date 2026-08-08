#!/usr/bin/env python3
"""Сверка подсчёта расхода с эталоном самого Claude Code.

Claude Code пишет итоги последней сессии каждого проекта в ~/.claude.json:
lastTotal*Tokens и lastModelUsage с разбивкой по моделям. Это независимый
источник правды — цифры посчитаны не нами и не из нашей арифметики.

Зародыш этапа 1.3 (docs/roadmap/1.3-verify.md). Наивная агрегация недобирает
5-15% по чтению кэша (--naive показывает, как было). Причина найдена: часть
запросов к API в транскрипт не пишется. Что удалось восстановить и что нет —
см. reconstruct() и сам документ этапа.

    python3 scripts/probe/ground-truth-check.py           реконструкция
    python3 scripts/probe/ground-truth-check.py --naive   как считалось раньше
    python3 scripts/probe/ground-truth-check.py --full    + транскрипты сабагентов
"""
import json
import os
import glob
import sys

FIELDS = ('in', 'out', 'cw', 'cr')


def zero():
    return dict.fromkeys(FIELDS, 0)


def usage_of(u):
    return {'in': u.get('input_tokens', 0), 'out': u.get('output_tokens', 0),
            'cw': u.get('cache_creation_input_tokens', 0),
            'cr': u.get('cache_read_input_tokens', 0)}


def read_session(path):
    """Возвращает (запросы, usage сабагентов из результатов вызова Agent).

    Один ответ API пишется несколькими строками assistant — по строке на блок
    контента — с общим requestId. Суммировать построчно нельзя, завысит в разы.
    Брать первую строку тоже нельзя: output_tokens в ней частичный, стриминг
    дописывает его по ходу ответа. Берём максимум по каждому полю.
    """
    acc, order, sub = {}, [], []
    for line in open(path, errors='replace'):
        try:
            r = json.loads(line)
        except ValueError:
            continue
        if r.get('type') == 'assistant':
            rid = r.get('requestId')
            v = usage_of(r['message']['usage'])
            if rid in acc:
                acc[rid] = {k: max(acc[rid][k], v[k]) for k in FIELDS}
            else:
                acc[rid] = v
                order.append(rid)
        elif r.get('type') == 'user':
            # Сабагент пишет собственный транскрипт (см. subagent_files), но в
            # основной поток возвращает только usage своего последнего запроса.
            tur = r.get('toolUseResult')
            if isinstance(tur, dict) and isinstance(tur.get('usage'), dict) \
                    and 'input_tokens' in tur['usage']:
                sub.append(usage_of(tur['usage']))
    return [acc[rid] for rid in order], sub


def subagent_files(path, session_id):
    """<каталог проекта>/<sessionId>/subagents/agent-<agentId>.jsonl.

    Полный транскрипт сабагента, с isSidechain: true и своими requestId.
    Эталон Claude Code его не читает: в lastModelUsage попадает только usage
    последнего запроса, вернувшийся в toolUseResult. Реальная стоимость
    сабагента в разы больше — на ollama-bar 1.27M чтения кэша против 212k.
    """
    d = os.path.join(os.path.dirname(path), session_id, 'subagents')
    return sorted(glob.glob(os.path.join(d, 'agent-*.jsonl')))


def reconstruct(reqs, tail=1):
    """Сумма с восстановлением запросов, которых в транскрипте нет.

    Префикс запроса N+1 обязан равняться префиксу N плюс то, что на N
    записалось в кэш: cr(N+1) == cr(N) + cw(N). Больше — значит между ними
    прошёл незаписанный запрос: он дописал в кэш ответ ассистента и прочитал
    весь префикс. Разрыв даёт его стоимость целиком.

    Такой же запрос уходит после последнего ответа сессии, но следа не
    оставляет — следующего запроса уже нет. По косвенным признакам их бывает
    от нуля до трёх; tail — это допущение, а не измерение.
    """
    t, last, warms = zero(), None, 0
    for r in reqs:
        if last is not None:
            gap = r['cr'] - (last['cr'] + last['cw'])
            if gap > 0:
                t['cr'] += last['cr'] + last['cw']
                t['cw'] += gap
                warms += 1
        for k in FIELDS:
            t[k] += r[k]
        last = r
    if last is not None:
        prefix, add = last['cr'] + last['cw'], last['out']
        for i in range(tail):
            t['cr'] += prefix
            if i == 0:
                t['cw'] += add
                prefix += add
            warms += 1
    return t, warms


def naive(reqs, tail=0):
    t = zero()
    for r in reqs:
        for k in FIELDS:
            t[k] += r[k]
    return t, 0


def main():
    mode_naive = '--naive' in sys.argv
    mode_full = '--full' in sys.argv
    cfg = json.load(open(os.path.expanduser('~/.claude.json')))
    files = {os.path.basename(p)[:-6]: p
             for p in glob.glob(os.path.expanduser('~/.claude/projects/*/*.jsonl'))}

    ok = bad = missing = 0
    print(f"{'проект':18} {'cr эталон':>12} {'cr наше':>12} {'расхожд.':>10} {'%':>8} "
          f"{'служ.':>5} {'саб.':>4}")
    for name, proj in cfg.get('projects', {}).items():
        sid = proj.get('lastSessionId')
        if not sid or not (proj.get('lastTotalCacheReadInputTokens') or 0):
            continue
        path = files.get(sid)
        if not path:
            missing += 1
            continue

        reqs, sub_usage = read_session(path)
        if not reqs:
            missing += 1
            continue

        summarize = naive if mode_naive else reconstruct
        got, warms = summarize(reqs)
        subs = subagent_files(path, sid)
        if mode_full and subs:
            # своя правда: полный расход сабагентов из их транскриптов
            for sp in subs:
                s_reqs, _ = read_session(sp)
                s_tot, _ = summarize(s_reqs, 0)
                for k in FIELDS:
                    got[k] += s_tot[k]
        elif not mode_naive:
            # правда эталона: только последний запрос каждого сабагента
            for u in sub_usage:
                for k in FIELDS:
                    got[k] += u[k]

        want = {'in': proj.get('lastTotalInputTokens') or 0,
                'out': proj.get('lastTotalOutputTokens') or 0,
                'cw': proj.get('lastTotalCacheCreationInputTokens') or 0,
                'cr': proj.get('lastTotalCacheReadInputTokens') or 0}
        d = want['cr'] - got['cr']
        exact = want['cr'] == got['cr'] and want['cw'] == got['cw']
        ok, bad = (ok + 1, bad) if exact else (ok, bad + 1)
        pct = '' if exact else f"{d / want['cr'] * 100:+.2f}%"
        print(f"{os.path.basename(name)[:18]:18} {want['cr']:12} {got['cr']:12} {d:10} "
              f"{pct:>8} {warms:5} {len(subs):4}")

    print(f"\nчтение и запись кэша сошлись точно: {ok}, разошлись: {bad}, "
          f"файла сессии нет: {missing}")
    print("Остаток — хвостовые служебные запросы (0..3 на сессию, следа не оставляют)")
    print("и служебные вызовы Haiku. Подробности: docs/roadmap/1.3-verify.md")
    return 0 if bad == 0 else 1


if __name__ == '__main__':
    raise SystemExit(main())
