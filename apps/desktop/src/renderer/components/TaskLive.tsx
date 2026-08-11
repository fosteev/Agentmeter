import type { LiveAgent } from '@agentmeter/ipc'
import { formatTokens, t } from '../format.ts'
import { AGENT_STATUS, Dot, statusLabel } from './AgentRow.tsx'

// Живая подпись задачи — этап 6.1, в макете этого нет.
//
// Лента отвечает на вопрос «куда ушёл день», и на вопрос «что происходит
// сейчас» у неё ответа не было вовсе: работающая минуту назад сессия стоит в
// самом низу списка по расходу, а то и в свёрнутом хвосте. Здесь дописывается
// ровно то, чего не хватало: чей ход, над каким запросом и во что этот ход уже
// обошёлся.
//
// Числа приезжают посчитанными (`LiveAgent.currentTurn`), компонент их только
// подставляет: расход хода считает ядро от метки, которой человек передал
// слово, — в окне этой метки нет и быть не должно.

export interface TaskLiveProps {
  agent: LiveAgent
  /** Строка ленты (одна строка, обрезается) или карточка (вопрос целиком). */
  density?: 'row' | 'card'
}

/**
 * Показывать ли, над чем идёт работа.
 *
 * У ждущего агента ход **у человека**: модель ответила и стоит. Вопрос под
 * такой строкой читался бы как «над этим сейчас работает», то есть был бы
 * ложью ровно в том месте, ради которого блок и написан. Расход хода при этом
 * остаётся: он уже случился и отвечает на «во что обошёлся последний ход».
 */
function showsPrompt(agent: LiveAgent): boolean {
  return agent.state === 'working' || agent.state === 'idle'
}

export function TaskLive({ agent, density = 'row' }: TaskLiveProps) {
  const status = AGENT_STATUS[agent.state]
  const turn = agent.currentTurn
  const prompt = showsPrompt(agent) ? turn?.prompt : undefined
  const card = density === 'card'

  // Слово состояния — у всех, кроме работающего: у того его говорит пульсирующая
  // точка, а «думает · сейчас: «…»» тратит на это половину строки.
  const state = status === 'done' || status === 'thinking' ? undefined : statusLabel(status)
  const spend =
    turn?.spend === undefined
      ? undefined
      : t('today.turnSpend', {
          tokens: `${turn.spend.tokens.confidence === 'exact' ? '' : '≈'}${formatTokens(turn.spend.tokens.value)}`,
        })
  // Темп мёртвого и ноль не показываем по тому же правилу, что в строке агента.
  const rate = agent.rate > 0 ? t('time.perMinute', { tokens: formatTokens(agent.rate) }) : undefined
  const tail = [spend, rate].filter((part) => part !== undefined).join(' · ')

  return (
    <div
      data-task-live={agent.sessionId}
      style={{
        display: 'flex',
        alignItems: card ? 'flex-start' : 'center',
        gap: 7,
        minWidth: 0,
        fontFamily: "'IBM Plex Mono', monospace",
        // Ступени — из блоков макета, на которые опирается компонент: 10.5 —
        // тихая подпись строки ленты, 11 — вторая строка строки агента в
        // попапе, то есть та же самая живая подпись в своём первом контексте.
        fontSize: card ? 11 : 10.5,
        fontVariantNumeric: 'tabular-nums',
        // Ждущий зовёт человека к машине — только у него янтарный. У молчащего
        // цвет тихий: он ничего не просит, мы просто не видим работы (2.2).
        color: agent.state === 'waiting' ? 'var(--warn)' : 'var(--tx2)',
      }}
    >
      <span style={{ display: 'flex', alignItems: 'center', height: 14, flex: 'none' }}>
        <Dot status={status} />
      </span>
      <span
        data-task-live-text
        style={{
          minWidth: 0,
          // В ленте вопрос обрезается по ширине колонки, в карточке — умещается
          // весь: место там есть, а обрезать дважды (ядром по `PROMPT_CHARS` и
          // ещё и здесь) значит спрятать то, ради чего карточку и раскрыли.
          ...(card
            ? { whiteSpace: 'pre-wrap' as const, wordBreak: 'break-word' as const }
            : {
                whiteSpace: 'nowrap' as const,
                overflow: 'hidden' as const,
                textOverflow: 'ellipsis' as const,
              }),
        }}
      >
        {[state, prompt === undefined ? undefined : t('today.liveNow', { prompt })]
          .filter((part): part is string => part !== undefined)
          .join(' · ')}
      </span>
      {tail === '' ? null : (
        <span data-task-live-spend style={{ flex: 'none', color: 'var(--tx3)' }}>
          {prompt === undefined && state === undefined ? tail : `· ${tail}`}
        </span>
      )}
    </div>
  )
}
