import type { LiveAgent, LiveSnapshot } from '@agentmeter/core'
import { formatDuration, formatTokens, plural, table } from '../format.ts'

/**
 * Живой снимок в терминале. Он же стенд для попапа (2.5): экран показывает
 * ровно эти поля, поэтому расхождение видно до первого нарисованного пикселя.
 */
export function renderLive(snapshot: LiveSnapshot, locale: string): string {
  const parts: string[] = []
  if (snapshot.agents.length === 0) {
    parts.push('сейчас никто не работает')
  } else {
    parts.push(plural(snapshot.agents.length, locale, ['агент', 'агента', 'агентов']))
    parts.push('')
    parts.push(
      table(
        [
          { header: 'Провайдер', width: 10 },
          { header: 'Проект', width: 22 },
          { header: 'Состояние', width: 10 },
          { header: 'Ход', width: 14 },
          { header: 'Живость', width: 9 },
          { header: 'В работе', width: 10 },
          { header: 'Тишина', width: 8 },
          { header: 'Токены', width: 10, align: 'right' },
          { header: 'Темп', width: 11, align: 'right' },
          { header: 'Запросов', width: 9, align: 'right' },
        ],
        snapshot.agents.map((agent) => row(agent, snapshot.at, locale)),
      ),
    )
  }
  for (const warning of snapshot.warnings) parts.push(`! ${warning}`)
  return parts.join('\n')
}

function row(agent: LiveAgent, at: number, locale: string): string[] {
  return [
    agent.provider,
    agent.project,
    agent.state === 'done'
      ? `завершился ${formatDuration(at - (agent.endedAt ?? at), locale)}`
      : stateName(agent.state),
    turnName(agent),
    // «Процесс» — проверенный факт, «тишина» — догадка по свежести лога.
    // У Codex реестра процессов нет вовсе, и выдавать догадку за факт нельзя.
    agent.liveness === 'process' ? 'процесс' : 'тишина',
    formatDuration(at - agent.startedAt, locale),
    formatDuration(at - agent.lastActivityAt, locale),
    `${agent.approximate ? '≈' : ''}${formatTokens(agent.tokens, locale)}`,
    agent.rate === 0 ? '—' : `${formatTokens(agent.rate, locale)}/мин`,
    String(agent.requests),
  ]
}

function stateName(state: LiveAgent['state']): string {
  if (state === 'working') return 'думает'
  if (state === 'waiting') return 'ждёт'
  if (state === 'done') return 'завершился'
  // Ход у агента, но в логе тишина: зависший инструмент, запрос разрешения,
  // уснувший процесс. Называть это «думает» — врать.
  return 'молчит'
}

/**
 * Чей ход по хвосту лога. Показывается рядом с состоянием намеренно: состояние
 * — вывод, ход — то, что прочитано из источника, и расхождение между ними
 * видно без отладчика.
 */
function turnName(agent: LiveAgent): string {
  if (agent.turn === undefined) return 'не видно'
  if (agent.turn === 'turn-end') return 'ход у человека'
  if (agent.turn === 'ask-pending') return `спросил${agent.pendingTool ? ` (${agent.pendingTool})` : ''}`
  if (agent.turn === 'tool-pending') return agent.pendingTool ?? 'инструмент'
  return 'ход у модели'
}
