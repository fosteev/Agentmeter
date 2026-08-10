// Полоса лимита. Состояния из строк 174–182 макета:
// норма <60 (ok) · близко 60–85 (warn) · предел >85 (alarm) · выбран 100 (вся
// полоса alarm, без заливки-дочернего). Точность — отдельная ось: оценка даёт
// штриховку warn и знак «≈», число уходит в tx2. Штриховка собирается из
// var(--warn) через color-mix, без цветовых литералов: прозрачный промежуток
// между штрихами — это warn на 32% альфы, как oklch(0.79 0.14 82 / 0.32) в макете.

// Подпись с прогнозом (2.3) макетом не нарисована — по
// design-implementation.md она вписывается сюда. Своего ответа у блока полосы
// на неё нет, поэтому взят ответ макета на то же отношение «строка и её тихая
// подпись» из блока AgentRow (строки 148–153): вертикальный зазор 3, mono 11 в
// tx3. Кегль 10 из макета сюда не годится — им набраны пояснения **к макету**
// («20/600», «думает (пульс)»), а не интерфейс, и в шести ступенях его нет.
// Знак «≈» в тексте стоит всегда: прогноз продлевает темп последних минут, а
// не измеряет.

export interface LimitBarProps {
  percent: number | null
  approximate: boolean
  /** Состояние «выбран 100»: полоса целиком alarm, без внутреннего fill. */
  selected?: boolean
  /** Готовая подпись прогноза, например «≈40 мин до упора». Считает не окно. */
  forecast?: string
}

type Level = 'ok' | 'warn' | 'alarm'

const LEVEL_COLOR: Record<Level, string> = {
  ok: 'var(--ok)',
  warn: 'var(--warn)',
  alarm: 'var(--alarm)',
}

function levelFor(percent: number): Level {
  if (percent > 85) return 'alarm'
  if (percent >= 60) return 'warn'
  return 'ok'
}

const HATCH = `repeating-linear-gradient(115deg, var(--warn) 0 3px, color-mix(in oklch, var(--warn) 32%, transparent) 3px 7px)`

export function LimitBar({ percent, approximate, selected, forecast }: LimitBarProps) {
  const pct = selected ? 100 : percent
  const known = pct !== null
  const level = known ? levelFor(pct) : 'ok'
  const labelColor = approximate ? 'var(--tx2)' : level === 'alarm' ? 'var(--alarm)' : 'var(--tx)'
  const labelText = known ? `${approximate ? '≈' : ''}${Math.round(pct)}%` : '—'

  const bar = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <div
        style={{
          flex: 1,
          height: 8,
          borderRadius: 4,
          background: selected ? 'var(--alarm)' : 'var(--s2)',
          overflow: 'hidden',
        }}
      >
        {selected ? null : (
          <div
            style={{
              width: `${pct ?? 0}%`,
              height: '100%',
              background: approximate ? HATCH : LEVEL_COLOR[level],
            }}
          />
        )}
      </div>
      <span
        style={{
          fontFamily: "'IBM Plex Mono', monospace",
          fontSize: 11,
          width: 46,
          textAlign: 'right',
          color: labelColor,
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {labelText}
      </span>
    </div>
  )

  if (forecast === undefined) return bar
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      {bar}
      <span
        style={{
          fontFamily: "'IBM Plex Mono', monospace",
          fontSize: 11,
          color: 'var(--tx3)',
          letterSpacing: '.06em',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {forecast}
      </span>
    </div>
  )
}
