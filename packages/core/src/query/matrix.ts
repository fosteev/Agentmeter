/**
 * Клетка «проект × модель» (8.1) — раздел 12 макета.
 *
 * Всё, из чего собирается ответ, уже лежит в индексе: модель на каждом запросе,
 * проект на сессии. Новое здесь ровно одно — группировка по двум ключам сразу,
 * и сделать её плохо можно единственным способом, зато незаметно: группировка
 * по двум ключам разъезжается с итогом периода **молча**. Сессия без проекта,
 * запрос без модели, сабагент, попавший в обе клетки, — и каждое отдельное
 * число на экране остаётся при этом настоящим.
 *
 * Отсюда устройство файла: клетки считаются одним `GROUP BY`, а итог периода —
 * **своим запросом**, без группировки. Сложи итог из тех же клеток — и сверка
 * станет тавтологией: сумма клеток сойдётся с суммой клеток при любой ошибке в
 * группировке. Ровно так у Codex устроена встроенная сверка с накопительным
 * итогом (правило 5), и там она обязательный тест, а не примечание.
 *
 * Плоская ось моделей из 4.2 (`breakdownReport`) при этом остаётся как есть:
 * клетке нужны два ключа, а склейка их в `pilot · claude-opus-5` текстом
 * превращает ключ в предложение — по нему нельзя ни отсортировать, ни сузить.
 */
import { t } from '../i18n/index.ts'
import type { Db } from '../index/db.ts'
import type { Provider } from '../sources/types.ts'
import { modelSpeeds, speedKey } from './speed.ts'
import { addTotals, emptyTotals, requestFilter, sourceCount, totalsFromRow } from './today.ts'
import type { DayRange, MatrixCell, MatrixRow, RequestScope, SpendMatrix, Totals } from './types.ts'

interface CellRow {
  project: string
  provider: Provider
  model: string
  input: number
  output: number
  cache_write: number
  cache_read: number
  requests: number
  inherited: number
}

/** Расход, как он считается везде в продукте (правило 16). Второго нет. */
export const SPEND = 'requests.input + requests.output + requests.cache_write + requests.cache_read'

export function spendMatrix(db: Db, range: DayRange, scope: RequestScope = {}): SpendMatrix {
  // Сужение — только отсюда. Свой `WHERE` по периоду и провайдеру, разъехавшись
  // с лентой на один знак сравнения, дал бы экран, где шапка и таблица считают
  // разные дни, и оба числа были бы настоящими.
  const filter = requestFilter(range, scope)
  // `requests.model`, а не `sessions.model`: у сессии модель одна — та, которой
  // сделан её первый запрос, — а по ходу работы она меняется. На живой машине
  // 13 разных значений в `requests.model` и сессии, где сменилось две. И имя
  // таблицы обязательно: колонка `model` есть в обеих, без него SQLite отвечает
  // `ambiguous column name` и подталкивает взять худшую из двух.
  const cells = db.all<CellRow>(
    `SELECT sessions.project AS project, sessions.provider AS provider,
            requests.model AS model,
            sum(requests.input) AS input, sum(requests.output) AS output,
            sum(requests.cache_write) AS cache_write,
            sum(requests.cache_read) AS cache_read, count(*) AS requests,
            -- Восстановленные запросы (1.3): модели в логе у них нет вовсе, она
            -- взята у соседа. Отбор по origin, а не по колонке synthetic и тем
            -- более не по модели с именем <synthetic>: одно слово, три разных
            -- смысла в соседних колонках.
            coalesce(sum(CASE WHEN requests.origin != 'log' THEN ${SPEND} ELSE 0 END), 0)
              AS inherited
     FROM requests
     JOIN sessions ON sessions.id = requests.session_id
     WHERE ${filter.sql}
     GROUP BY sessions.project, sessions.provider, requests.model`,
    ...filter.params,
  )
  const summary = db.get<Omit<CellRow, 'project' | 'provider' | 'model' | 'inherited'>>(
    `SELECT coalesce(sum(requests.input), 0) AS input,
            coalesce(sum(requests.output), 0) AS output,
            coalesce(sum(requests.cache_write), 0) AS cache_write,
            coalesce(sum(requests.cache_read), 0) AS cache_read,
            count(*) AS requests
     FROM requests
     JOIN sessions ON sessions.id = requests.session_id
     WHERE ${filter.sql}`,
    ...filter.params,
  )!
  const totals = totalsFromRow(summary)

  const projects = new Map<string, { totals: Totals; cells: MatrixCell[] }>()
  const models = new Map<string, MatrixCell>()
  for (const row of cells) {
    const cell: MatrixCell = {
      model: row.model,
      provider: row.provider,
      totals: totalsFromRow(row),
      inherited: row.inherited,
    }
    const project = projects.get(row.project) ?? { totals: emptyTotals(), cells: [] }
    addTotals(project.totals, cell.totals)
    project.cells.push(cell)
    projects.set(row.project, project)

    // Ключ маргинали — пара «провайдер + модель», а не одно имя: `provider` в
    // клетке обязан оставаться фактом, а не догадкой по первой букве имени.
    const key = speedKey(row.provider, row.model)
    const marginal = models.get(key)
    if (marginal === undefined) {
      // Копия `totals`, а не та же ссылка: иначе клетка модели, попавшей в два
      // проекта, вырастет вместе с маргиналью — и строка проекта покажет расход
      // обоих проектов сразу.
      models.set(key, { ...cell, totals: { ...cell.totals } })
    } else {
      addTotals(marginal.totals, cell.totals)
      marginal.inherited += cell.inherited
    }
  }

  // Скорость (8.4) — тем же сужением и тем же периодом, своей функцией: CLI и
  // бриф 7.7 берут её оттуда же, и третий экземпляр медианы однажды отстал бы
  // от двух первых. Только маргиналь: у клетки проекта выборка в разы меньше.
  const speeds = modelSpeeds(db, range, scope)
  for (const [key, marginal] of models) {
    const speed = speeds.get(key)
    if (speed !== undefined) marginal.speed = speed
  }

  return {
    rows: [...projects.entries()]
      .map(([project, value]): MatrixRow => ({
        project,
        totals: value.totals,
        cells: value.cells.sort(byTotal),
      }))
      .sort(
        (left, right) =>
          right.totals.total - left.totals.total || left.project.localeCompare(right.project),
      ),
    models: [...models.values()].sort(byTotal),
    totals,
    emptyIndex: sourceCount(db) === 0,
    emptyScope: totals.requests === 0,
  }
}

/**
 * Как называется строка проекта на экране и в CLI.
 *
 * Сессии с пустым `project` в индексе есть — 29 на живой машине, — и запросов у
 * них сегодня ноль, то есть строки они не создают. Появятся — строка обязана
 * получить имя словами: пустая ячейка в таблице читается как поломка вёрстки, а
 * не как факт. Функция одна на всех потребителей по тому же доводу, что у
 * `toolRowLabel`: третий её экземпляр однажды отстанет от двух первых.
 *
 * Ключом при этом остаётся пустая строка — именно ею сужается запрос
 * (`RequestScope.project`), и подмени мы её словами, фильтр перестал бы
 * находить свои же строки.
 */
export function projectRowLabel(project: string): string {
  return project === '' ? t('matrix.noProject') : project
}

/** По убыванию расхода; при равенстве — по имени, чтобы порядок не плавал. */
function byTotal(left: MatrixCell, right: MatrixCell): number {
  return right.totals.total - left.totals.total || left.model.localeCompare(right.model)
}
