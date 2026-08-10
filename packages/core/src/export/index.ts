/**
 * Экспорт расхода в CSV и JSON (4.8).
 *
 * Макета у этапа нет и не нужно: это команда CLI и пункт меню. Зато есть три
 * решения, из-за которых экспорт живёт в ядре, а не в двух местах по копии.
 *
 * **Первое: в строке едет признак точности, а не только число.** На экране
 * оценку называет знак `≈`, но в таблице `≈344.9M` — это текст, а не число, и
 * складывать его нельзя. Поэтому число остаётся числом, а рядом стоит колонка
 * `approximate`. Выкинь её — и человек получит колонку, которая выглядит
 * измеренной целиком, хотя часть строк восстановлена арифметикой (1.3).
 *
 * **Второе: токены выгружаются четырьмя видами, а не итогом.** Итог из них
 * складывается, а обратно не раскладывается; отдать одну колонку значит отдать
 * таблицу, в которой нельзя посчитать ничего из того, ради чего продукт
 * написан.
 *
 * **Третье: CSV пишется с BOM.** Excel читает UTF-8 без него как однобайтовую
 * кодировку, и русские имена проектов превращаются в мусор — молча, потому что
 * файл при этом открывается.
 */
import type { Db } from '../index/db.ts'
import { dayRange } from '../query/day.ts'
import { taskRows } from '../query/tasks.ts'
import { todayReport } from '../query/today.ts'
import type { DayRange } from '../query/types.ts'

/** Что за строка в выгрузке: день целиком или отдельная задача. */
export type ExportGrain = 'day' | 'task'

export interface ExportRow {
  /** Дата в ISO, `YYYY-MM-DD` — сортируется как текст и читается как дата. */
  date: string
  /** У строки дня пусто: провайдеров в дне несколько. */
  provider: string
  project: string
  branch: string
  ticket: string
  title: string
  startedAt: string
  input: number
  output: number
  cacheWrite: number
  cacheRead: number
  total: number
  requests: number
  /**
   * В расходе есть восстановленные запросы (1.3), и число — нижняя оценка.
   * Отдельной колонкой, потому что знак `≈` внутри числа делает его текстом.
   */
  approximate: boolean
}

export const EXPORT_COLUMNS: Array<keyof ExportRow> = [
  'date',
  'provider',
  'project',
  'branch',
  'ticket',
  'title',
  'startedAt',
  'input',
  'output',
  'cacheWrite',
  'cacheRead',
  'total',
  'requests',
  'approximate',
]

/**
 * Строки выгрузки за период.
 *
 * Читается тем же `taskRows`, которым собрана лента, и тем же `todayReport`,
 * которым собрана шапка: выгрузка обязана совпасть с экраном до токена, а
 * второй сбор «почти как там» разошёлся бы с первым молча — и увидеть это можно
 * было бы только сложив CSV в редакторе.
 */
export function exportRows(
  db: Db,
  range: DayRange,
  grain: ExportGrain,
  dayStartsAtHour = 0,
): ExportRow[] {
  if (grain === 'task') {
    return taskRows(db, range).map((row) => ({
      date: isoDate(row.startedAt),
      provider: row.provider,
      project: row.project,
      branch: row.branch ?? '',
      ticket: row.ticket ?? '',
      title: row.title ?? '',
      startedAt: new Date(row.startedAt).toISOString(),
      input: row.totals.input,
      output: row.totals.output,
      cacheWrite: row.totals.cacheWrite,
      cacheRead: row.totals.cacheRead,
      total: row.totals.total,
      requests: row.totals.requests,
      approximate: row.approximate,
    }))
  }

  // Обход идёт по наблюдаемому окну, а не по запрошенному периоду. Период
  // бывает открытым с обеих сторон («всё, что есть»), и честный цикл от нуля
  // означал бы двадцать тысяч запросов к индексу ради двадцати тысяч пустых
  // суток — то есть выгрузка за всё время висела бы минуту без единой строки.
  const span = db.get<{ first: number | null; last: number | null }>(
    'SELECT min(ts) AS first, max(ts) AS last FROM requests WHERE ts >= ? AND ts < ?',
    range.from,
    range.to,
  )
  if (span?.first == null || span.last == null) return []

  const rows: ExportRow[] = []
  const stop = dayRange(span.last, dayStartsAtHour).to
  for (let at = dayRange(span.first, dayStartsAtHour).from; at < stop; ) {
    const day = dayRange(at, dayStartsAtHour)
    const report = todayReport(db, day)
    at = dayRange(at, dayStartsAtHour, 1).from
    // Дни без расхода в выгрузку не попадают: строка из нулей означала бы
    // «посчитали, и вышло ноль», а сутки, в которые не работали, — это не ноль
    // расхода, а отсутствие строки (то же различение, что в «Истории», 4.6).
    if (report.totals === null) continue
    rows.push({
      date: isoDate(day.from),
      provider: '',
      project: '',
      branch: '',
      ticket: '',
      title: '',
      startedAt: new Date(day.from).toISOString(),
      input: report.totals.input,
      output: report.totals.output,
      cacheWrite: report.totals.cacheWrite,
      cacheRead: report.totals.cacheRead,
      total: report.totals.total,
      requests: report.totals.requests,
      approximate: report.approximate,
    })
  }
  return rows
}

/** Байтовая метка порядка — без неё Excel читает UTF-8 не как UTF-8. */
export const CSV_BOM = '﻿'

/**
 * Строки в CSV по RFC 4180.
 *
 * Кавычится не «когда нужно», а по правилу: поле с запятой, кавычкой,
 * переводом строки или ведущим пробелом. Имя ветки `feat/a,b` и название задачи
 * с кавычками встречаются, и без кавычек такая строка съезжает на колонку —
 * тихо, потому что файл остаётся валидным.
 */
export function toCsv(rows: readonly ExportRow[]): string {
  const header = EXPORT_COLUMNS.join(',')
  const body = rows.map((row) => EXPORT_COLUMNS.map((column) => cell(row[column])).join(','))
  return `${CSV_BOM}${[header, ...body].join('\r\n')}\r\n`
}

function cell(value: string | number | boolean): string {
  if (typeof value === 'number') return String(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (!/[",\r\n]|^\s|\s$/.test(value)) return value
  return `"${value.replaceAll('"', '""')}"`
}

/** Дата в локальном времени: день в выгрузке тот же, что на экране. */
function isoDate(at: number): string {
  const date = new Date(at)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}
