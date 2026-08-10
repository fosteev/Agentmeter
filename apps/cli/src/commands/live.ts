import type { LiveAgent, LiveSnapshot } from '@agentmeter/core'
import { t } from '@agentmeter/core'
import { formatDuration, formatTokens, table } from '../format.ts'

/**
 * Живой снимок в терминале. Он же стенд для попапа (2.5): экран показывает
 * ровно эти поля, поэтому расхождение видно до первого нарисованного пикселя.
 */
export function renderLive(snapshot: LiveSnapshot, locale: string): string {
  const parts: string[] = []
  if (snapshot.agents.length === 0) {
    parts.push(t('cli.nobody'))
  } else {
    parts.push(t('cli.agents', { count: snapshot.agents.length }))
    parts.push('')
    parts.push(
      table(
        [
          { header: t('cli.columnProvider'), width: 10 },
          { header: t('cli.columnProject'), width: 22 },
          { header: t('cli.columnState'), width: 10 },
          { header: t('cli.columnTurn'), width: 14 },
          { header: t('cli.columnLiveness'), width: 9 },
          { header: t('cli.columnWorking'), width: 10 },
          { header: t('cli.columnSilence'), width: 8 },
          { header: t('cli.columnTokens'), width: 10, align: 'right' },
          { header: t('cli.columnRate'), width: 11, align: 'right' },
          { header: t('cli.columnContext'), width: 9, align: 'right' },
          { header: t('cli.columnRequests'), width: 9, align: 'right' },
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
      ? t('state.finishedAgo', { ago: formatDuration(at - (agent.endedAt ?? at), locale) })
      : stateName(agent.state),
    turnName(agent),
    // «Процесс» — проверенный факт, «тишина» — догадка по свежести лога.
    // У Codex реестра процессов нет вовсе, и выдавать догадку за факт нельзя.
    agent.liveness === 'process' ? t('state.liveProcess') : t('state.liveSilence'),
    formatDuration(at - agent.startedAt, locale),
    formatDuration(at - agent.lastActivityAt, locale),
    `${agent.approximate ? '≈' : ''}${formatTokens(agent.tokens, locale)}`,
    agent.rate === 0 ? '—' : t('time.perMinute', { tokens: formatTokens(agent.rate, locale) }),
    // Прочерк, а не «0%»: размера окна у Claude в логах нет вовсе, и пустое
    // заполнение читалось бы как «контекст свободен» (2.6).
    contextCell(agent),
    String(agent.requests),
  ]
}

/**
 * Заполнение контекстного окна. Знак «≈» — там, где размер окна выведен из
 * наблюдений, а не написан провайдером: у Codex он в логе есть, у Claude нет.
 */
function contextCell(agent: LiveAgent): string {
  const context = agent.context
  if (context === undefined) return '—'
  return `${context.source === 'log' ? '' : '≈'}${Math.round(context.fill * 100)}%`
}

function stateName(state: LiveAgent['state']): string {
  if (state === 'working') return t('state.thinking')
  if (state === 'waiting') return t('state.waitingShort')
  if (state === 'done') return t('state.finished')
  // Ход у агента, но в логе тишина: зависший инструмент, запрос разрешения,
  // уснувший процесс. Называть это «думает» — врать.
  return t('state.silent')
}

/**
 * Чей ход по хвосту лога. Показывается рядом с состоянием намеренно: состояние
 * — вывод, ход — то, что прочитано из источника, и расхождение между ними
 * видно без отладчика.
 */
function turnName(agent: LiveAgent): string {
  if (agent.turn === undefined) return t('state.notSeen')
  if (agent.turn === 'turn-end') return t('state.turnHuman')
  if (agent.turn === 'ask-pending') {
    return agent.pendingTool === undefined
      ? t('state.asked')
      : t('state.askedWith', { tool: agent.pendingTool })
  }
  if (agent.turn === 'tool-pending') return agent.pendingTool ?? t('state.tool')
  return t('state.turnModel')
}
