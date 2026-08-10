/**
 * Разрезы дня по часам и по проектам — правая колонка вкладки «Сегодня»
 * (строки 737–762 макета).
 *
 * Отдельным модулем, а не полем в `todayReport`: там `projects` и `hours` уже
 * есть, но без провайдера, и разрез по провайдеру нужен ровно этим двум блокам.
 * Дописать его в общий отчёт значило бы утяжелить каждый вызов CLI ради экрана,
 * который CLI не рисует.
 *
 * Провайдер здесь — не украшение. В макете столбик часа составной (строка 742),
 * а полоса проекта покрашена в цвет того, кто в этом проекте работал: сказать
 * «расход по проектам» и не сказать чей — значит спрятать половину ответа на
 * вопрос «куда ушло».
 */
import type { Db } from '../index/db.ts'
import type { Provider } from '../sources/types.ts'
import { ticketKey } from './ticket.ts'
import { requestFilter } from './today.ts'
import type { DayRange, RequestScope } from './types.ts'

/** Сколько токенов пришлось на одного провайдера внутри часа или проекта. */
export interface ProviderSlice {
  provider: Provider
  total: number
}

export interface HourSplit {
  /** Час в локальной зоне, 0..23 — та же зона, в которой нарезан день. */
  hour: number
  total: number
  /** По убыванию расхода: первым тот, кто в этом часе стоил дороже. */
  slices: ProviderSlice[]
}

export interface ProjectSplit {
  project: string
  total: number
  slices: ProviderSlice[]
  /** Сколько запросов проекта восстановлено (1.3) — из этого выводится точность. */
  reconstructed: number
}

/**
 * Строка разреза «по тикетам» (3.7).
 *
 * Ключ приходит из имени ветки правилом `query/ticket.ts`. Сессии без ключа
 * сюда не попадают вовсе, и это не потеря: «работа вне тикета» — не тикет, а
 * строка с пустым именем в списке тикетов читалась бы как тикет без названия.
 * Сколько расхода осталось за пределами разреза, видно из итога дня.
 */
export interface TicketSplit {
  ticket: string
  total: number
  slices: ProviderSlice[]
  reconstructed: number
}

interface SplitRow {
  ts: number
  provider: Provider
  project: string
  branch: string | null
  total: number
  reconstructed: number
}

export function daySplits(
  db: Db,
  range: DayRange,
  scope: RequestScope = {},
): { hours: HourSplit[]; projects: ProjectSplit[]; tickets: TicketSplit[] } {
  const filter = requestFilter(range, scope)
  const rows = db.all<SplitRow>(
    `SELECT requests.ts, sessions.provider, sessions.project, sessions.branch,
            requests.input + requests.output + requests.cache_write + requests.cache_read AS total,
            (requests.origin != 'log') AS reconstructed
     FROM requests
     JOIN sessions ON sessions.id = requests.session_id
     WHERE ${filter.sql}`,
    ...filter.params,
  )

  const hours = new Map<number, Map<Provider, number>>()
  const projects = new Map<string, { slices: Map<Provider, number>; reconstructed: number }>()
  // Ключ вычисляется здесь, а не в SQL: правило извлечения — измерение, и
  // жить ему в одном месте (`query/ticket.ts`), а не двумя регулярками, из
  // которых одна написана на диалекте SQLite.
  const tickets = new Map<string, { slices: Map<Provider, number>; reconstructed: number }>()

  for (const row of rows) {
    // Час берётся из локального времени, а не из UTC: день на этом экране
    // календарный, и «расход в 09» обязан значить то же, что показывают часы
    // на стене.
    const hour = new Date(row.ts).getHours()
    const byProvider = hours.get(hour) ?? new Map<Provider, number>()
    byProvider.set(row.provider, (byProvider.get(row.provider) ?? 0) + row.total)
    hours.set(hour, byProvider)

    const project = projects.get(row.project) ?? {
      slices: new Map<Provider, number>(),
      reconstructed: 0,
    }
    project.slices.set(row.provider, (project.slices.get(row.provider) ?? 0) + row.total)
    project.reconstructed += row.reconstructed
    projects.set(row.project, project)

    const key = ticketKey(row.branch)
    if (key !== null) {
      const ticket = tickets.get(key) ?? { slices: new Map<Provider, number>(), reconstructed: 0 }
      ticket.slices.set(row.provider, (ticket.slices.get(row.provider) ?? 0) + row.total)
      ticket.reconstructed += row.reconstructed
      tickets.set(key, ticket)
    }
  }

  return {
    hours: [...hours.entries()]
      .sort(([left], [right]) => left - right)
      .map(([hour, byProvider]) => {
        const slices = toSlices(byProvider)
        return { hour, total: sum(slices), slices }
      }),
    projects: [...projects.entries()]
      .map(([project, value]) => {
        const slices = toSlices(value.slices)
        return { project, total: sum(slices), slices, reconstructed: value.reconstructed }
      })
      .sort((left, right) => right.total - left.total || left.project.localeCompare(right.project)),
    tickets: [...tickets.entries()]
      .map(([ticket, value]) => {
        const slices = toSlices(value.slices)
        return { ticket, total: sum(slices), slices, reconstructed: value.reconstructed }
      })
      .sort((left, right) => right.total - left.total || left.ticket.localeCompare(right.ticket)),
  }
}

function toSlices(byProvider: ReadonlyMap<Provider, number>): ProviderSlice[] {
  return [...byProvider.entries()]
    .map(([provider, total]) => ({ provider, total }))
    .sort((left, right) => right.total - left.total || left.provider.localeCompare(right.provider))
}

function sum(slices: readonly ProviderSlice[]): number {
  return slices.reduce((total, slice) => total + slice.total, 0)
}
