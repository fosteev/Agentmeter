import type { SpendCategoryRow } from '@agentmeter/ipc'
import { formatTokens, t } from '../format.ts'
import { mono } from './SpendCategoryTable.tsx'

/**
 * Что лежит в статье префикса — подсказка по наведению на строку (4.9).
 *
 * **Показом управляет CSS, а не состояние.** Правило висит на
 * `[data-spend-category]:hover [data-spend-detail]` в `tokens.css`, и выбрано
 * оно не из любви к простоте: тесты окна рендерят статическую разметку
 * (`renderToStaticMarkup`), jsdom в проекте нет, и подсказка на `useState`
 * осталась бы непроверяемой целиком. Здесь же содержимое проверяется разметкой,
 * а правило показа — чтением файла стилей. Заодно `:focus-within` открывает её с
 * клавиатуры, чего наведение мышью не умеет.
 *
 * Ничего не считается: имена, охват и число сессий приезжают посчитанными
 * (правило 3.0). Окно решает ровно одно — сколько строк поместилось, — и об
 * отброшенных говорит вслух («и ещё 24»), потому что молча обрезанный список
 * читается как полный.
 *
 * Цены штуки внутри списка нет намеренно. Число стоит там, где статья измерена
 * отдельным блоком префикса, — у сервера MCP свои байты и свой вес в дележе, и
 * он приезжает в `sources` с токенами. Доля строки внутри одного блока была бы
 * долей от доли: цена самого блока уже получена дележом остатка (1.7, 4.1).
 */
export interface SpendDetailProps {
  row: SpendCategoryRow
  /** Открываться вверх: у нижних строк списка внизу места нет. */
  up: boolean
}

/**
 * Сколько имён показываем. Дальше — «и ещё N».
 *
 * Двенадцать — это высота, а не вкус: строка списка 18 px, карточка не должна
 * перерастать окно (740 px по умолчанию, 560 минимум) вместе с шапкой, полосой
 * и оговоркой снизу.
 */
const VISIBLE = 12

export function SpendDetail({ row, up }: SpendDetailProps) {
  const hidden = Math.max(0, row.detail.names.length - VISIBLE)
  // «3 из 62» читается как «звали три инструмента из шестидесяти двух», и
  // осмысленно это только у статьи, где `loaded` считает инструменты. У
  // инструкций MCP блок один на сервер, то есть `loaded` там всегда единица, —
  // и на живых логах serena дала бы «16 из 1». Ей показывается число вызовов:
  // оно отвечает на тот же вопрос и не врёт ни на одной статье.
  const tools = row.key === 'mcpTools estimated'

  return (
    <div
      data-spend-detail={row.key}
      style={{
        position: 'absolute',
        left: 0,
        ...(up ? { bottom: 'calc(100% + 8px)' } : { top: 'calc(100% + 8px)' }),
        zIndex: 20,
        width: 340,
        maxWidth: '100%',
        padding: 12,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        background: 'var(--s1)',
        border: '1px solid var(--line)',
        borderRadius: 'var(--r-inner)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
        <span
          style={{
            ...mono(10.5),
            letterSpacing: '.14em',
            textTransform: 'uppercase',
            color: 'var(--tx3)',
          }}
        >
          {t('breakdown.detailTitle')}
        </span>
        <span style={{ fontSize: 11.5, color: 'var(--tx2)' }}>{row.label}</span>
      </div>

      {row.sources.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {row.sources.slice(0, VISIBLE).map((source) => (
            <div
              key={source.source}
              data-spend-detail-source={source.source}
              style={{ display: 'grid', gridTemplateColumns: '1fr auto auto', gap: 8, alignItems: 'baseline' }}
            >
              <span style={{ fontSize: 11.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {source.source}
              </span>
              <span style={{ ...mono(10.5, 'right'), color: 'var(--tx3)' }}>
                {tools
                  ? t('breakdown.usedOf', { used: source.used, loaded: source.loaded })
                  : t('breakdown.calls', { count: source.calls })}
              </span>
              <span style={{ ...mono(10.5, 'right'), color: 'var(--tx2)', minWidth: 52 }}>
                {source.period.confidence === 'exact' ? '' : '≈'}
                {formatTokens(source.period.value)}
              </span>
            </div>
          ))}
        </div>
      )}

      {row.detail.names.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {row.detail.names.slice(0, VISIBLE).map((item) => (
            <div
              key={item.name}
              data-spend-detail-name={item.name}
              style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 8, alignItems: 'baseline' }}
            >
              <span style={{ fontSize: 11.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {item.name}
              </span>
              {/* Охват молчит при полном: «в 14 из 14» на каждой строке — это
                  шум, из которого не следует ни одного решения. */}
              {item.sessions < row.detail.sessions && (
                <span style={{ ...mono(10.5, 'right'), color: 'var(--tx3)' }}>
                  {t('breakdown.detailIn', { count: item.sessions, total: row.detail.sessions })}
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      {hidden > 0 && (
        <span data-spend-detail-more={hidden} style={{ ...mono(10.5), color: 'var(--tx3)' }}>
          {t('breakdown.detailMore', { count: hidden })}
        </span>
      )}

      {row.detail.note !== undefined && (
        <span data-spend-detail-note style={{ fontSize: 11.5, color: 'var(--tx2)', lineHeight: 1.5 }}>
          {row.detail.note}
        </span>
      )}
    </div>
  )
}
