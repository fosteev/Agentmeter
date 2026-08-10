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
          { header: 'Живость', width: 9 },
          { header: 'В работе', width: 10 },
          { header: 'Тишина', width: 8 },
          { header: 'Токены', width: 10, align: 'right' },
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
    stateName(agent.state),
    // «Процесс» — проверенный факт, «тишина» — догадка по свежести лога.
    // У Codex реестра процессов нет вовсе, и выдавать догадку за факт нельзя.
    agent.liveness === 'process' ? 'процесс' : 'тишина',
    formatDuration(at - agent.startedAt, locale),
    formatDuration(at - agent.lastActivityAt, locale),
    `${agent.approximate ? '≈' : ''}${formatTokens(agent.tokens, locale)}`,
    String(agent.requests),
  ]
}

function stateName(state: LiveAgent['state']): string {
  if (state === 'working') return 'работает'
  if (state === 'waiting') return 'ждёт'
  if (state === 'done') return 'закончил'
  return 'простой'
}
