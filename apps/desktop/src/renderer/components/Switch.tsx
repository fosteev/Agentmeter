/**
 * Тумблер — строки 1236–1243 макета.
 *
 * Отдельным файлом с 5.3, когда переключателей стало три в двух разделах.
 * До этого он жил внутри «Приватности», и копия для автозапуска означала бы
 * две геометрии одного элемента: разъезжаются такие копии не сразу и не
 * заметно — сперва на пиксель скругления, потом на цвет выключенного.
 *
 * Системный `input` лежит поверх невидимым, а видимое рисуется прямоугольниками:
 * привести чекбокс к виду макета средствами платформы нельзя ни на одной из трёх.
 * Отсюда единственный ноль в отступах, которого нет в макете, — сброс
 * браузерного `margin` у `input` (он же в `OFF_SPEC`).
 */
export interface SwitchProps {
  /** Имя для `data-setting` — по нему ручку находят тесты и витрина. */
  name: string
  label: string
  /** Тихая приписка справа от подписи: пояснение или причина недоступности. */
  note?: string | undefined
  checked: boolean
  /** Выключенный тумблер остаётся видимым: пропавшая настройка читается как
   *  «её здесь нет», а не как «здесь она не сработает». */
  disabled?: boolean
  onChange: (value: boolean) => void
}

export function Switch({ name, label, note, checked, disabled = false, onChange }: SwitchProps) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
      <span style={{ fontSize: 12.5, color: disabled ? 'var(--tx3)' : 'var(--tx)' }}>
        {label}{' '}
        {note !== undefined && <span style={{ color: 'var(--tx3)', fontSize: 11.5 }}>{note}</span>}
      </span>
      <span
        style={{
          width: 34,
          height: 19,
          borderRadius: 10,
          background: checked ? 'var(--ok)' : 'var(--s2)',
          position: 'relative',
          flex: 'none',
          opacity: disabled ? 0.5 : 1,
        }}
      >
        <span
          style={{
            position: 'absolute',
            ...(checked ? { right: 2 } : { left: 2 }),
            top: 2,
            width: 15,
            height: 15,
            borderRadius: '50%',
            background: checked ? 'var(--bg)' : 'var(--tx3)',
          }}
        />
        <input
          type="checkbox"
          data-setting={name}
          checked={checked}
          disabled={disabled}
          onChange={(event) => onChange(event.currentTarget.checked)}
          style={{
            position: 'absolute',
            inset: 0,
            margin: 0,
            opacity: 0,
            cursor: disabled ? 'default' : 'pointer',
          }}
        />
      </span>
    </label>
  )
}
