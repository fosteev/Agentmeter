import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ingestFile, openDb, type Db, type SourceFile } from '@agentmeter/core'
import type { TaskRow, TodayFilter } from '@agentmeter/ipc'
import { buildDayReport, foldTail } from '../src/main/day.ts'

/**
 * `DayReport` на настоящем индексе из фикстур.
 *
 * Фикстура окна (`fixtures/window/`) описывает, каким отчёт обязан быть; этот
 * тест проверяет, что его таким собирают. Одного без другого мало: красивая
 * фикстура при кривой сборке даёт зелёный экран с враньём, а сборка без
 * фикстуры — экран, про который неизвестно, как он должен выглядеть.
 *
 * Проверки названы по поломке, которую ловят.
 */

const claudeDir = fileURLToPath(new URL('../../../fixtures/claude/', import.meta.url))
const codexDir = fileURLToPath(new URL('../../../fixtures/codex/', import.meta.url))
const ALL: TodayFilter = { from: 0, to: Date.parse('2030-01-01T00:00:00.000Z') }

let dir: string
let db: Db

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agentmeter-day-'))
  db = openDb(join(dir, 'index.sqlite')).db
  for (const name of ['compact', 'images', 'mcp', 'parallel', 'plain', 'sidechain']) {
    ingest({ path: join(claudeDir, `${name}.jsonl`), provider: 'claude', kind: 'session' })
  }
  // Транскрипт сабагента — отдельный файл, и без него дерево задачи состоит из
  // одного корня: проверка на детей прошла бы на пустом входе (3.5).
  ingest({
    path: join(claudeDir, 'sidechain.subagents', 'agent-a6bf337b0067775dd.jsonl'),
    provider: 'claude',
    kind: 'subagent',
    parentPath: join(claudeDir, '92cc27dc-193d-4c2c-aef1-843d7d41aeab.jsonl'),
  })
  ingest({ path: join(codexDir, 'rollout.jsonl'), provider: 'codex', kind: 'session' })
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

function ingest(file: SourceFile): void {
  expect(ingestFile(db, file).parsed).toBe(true)
}

describe('buildDayReport', () => {
  /**
   * Ловит отчёт, на котором окну пришлось бы складывать самому: шапка обязана
   * сходиться и с лентой, и с обоими разрезами. Разойдись любая из трёх сумм —
   * и на экране будут два разных числа про один и тот же день.
   */
  it('итог сходится с лентой, с часами и с проектами', () => {
    const report = buildDayReport(db, ALL)
    const total = report.totals.total.value
    expect(total).toBeGreaterThan(0)
    expect(report.tasks.reduce((sum, task) => sum + task.tokens.value, 0)).toBe(total)
    expect(report.byHour.reduce((sum, hour) => sum + hour.total, 0)).toBe(total)
    expect(report.byProject.reduce((sum, row) => sum + row.tokens.value, 0)).toBe(total)
    for (const hour of report.byHour) {
      expect(hour.total).toBe(hour.slices.reduce((sum, slice) => sum + slice.tokens, 0))
    }
  })

  /**
   * Ловит сужение, доехавшее только до ленты.
   *
   * Отфильтруй список задач, оставив итог и разрезы за весь день, — и шапка
   * покажет весь день над лентой из одного проекта. Числа при этом останутся
   * настоящими каждое по себе, и заметить это можно только сложив их руками.
   */
  it('сужение по проекту доезжает до итога, часов и разреза, а не только до ленты', () => {
    const all = buildDayReport(db, ALL)
    const project = all.byProject[0]!.project
    expect(project).toBeTruthy()
    const scoped = buildDayReport(db, { ...ALL, project })

    expect(scoped.tasks.every((task) => task.project === project)).toBe(true)
    expect(scoped.totals.total.value).toBeLessThan(all.totals.total.value)
    expect(scoped.tasks.reduce((sum, task) => sum + task.tokens.value, 0)).toBe(
      scoped.totals.total.value,
    )
    expect(scoped.byHour.reduce((sum, hour) => sum + hour.total, 0)).toBe(scoped.totals.total.value)
    expect(scoped.byProject.map((row) => row.project)).toEqual([project])
  })

  /**
   * Ловит `emptyDay`, посчитанный уже суженным итогом.
   *
   * «За день ничего не делали» и «фильтр отсёк всё» — разные экраны с разными
   * словами. Считай флаг после фильтра — и второй экран исчезнет: окно скажет
   * «сегодня пусто» человеку, который просто выбрал Codex в клодовый день.
   */
  it('пустой день не путается с пустым фильтром', () => {
    const nobody = buildDayReport(db, { ...ALL, project: 'такого-проекта-нет' })
    expect(nobody.tasks).toEqual([])
    expect(nobody.emptyDay).toBe(false)
    expect(nobody.emptyIndex).toBe(false)

    const otherDay = buildDayReport(db, { from: 0, to: 1 })
    expect(otherDay.tasks).toEqual([])
    expect(otherDay.emptyDay).toBe(true)
  })

  /**
   * Ловит ленту, отсортированную не тем ключом: числа в ней остаются
   * настоящими, и порядок — единственное, чем этот сбой виден.
   *
   * Свёртки здесь нет вовсе — на восьми фикстурах задач семь и все дорогие, —
   * поэтому её правило проверяется отдельным блоком ниже, на списке с хвостом.
   * Проверять «по времени свёртки нет» на данных, где её нет ни при какой
   * сортировке, значит проверять пустоту.
   */
  it('лента отсортирована запрошенным ключом', () => {
    const report = buildDayReport(db, ALL)
    const values = report.tasks.map((task) => task.tokens.value)
    expect(values).toEqual([...values].sort((left, right) => right - left))

    const byTime = buildDayReport(db, { ...ALL, sort: 'started' })
    const starts = byTime.tasks.map((task) => task.startedAt)
    expect(starts).toEqual([...starts].sort((left, right) => right - left))

    const byRequests = buildDayReport(db, { ...ALL, sort: 'requests' })
    const requests = byRequests.tasks.map((task) => task.requests)
    expect(requests).toEqual([...requests].sort((left, right) => right - left))
  })

  /**
   * Ловит разрез по часам, потерявший провайдера: столбик в макете составной, и
   * если группировка схлопнет провайдеров, час покрасится одним цветом молча.
   */
  it('часы знают обоих провайдеров, и сумма по провайдеру сходится с суженным итогом', () => {
    const report = buildDayReport(db, ALL)
    const seen = new Set(
      report.byHour.flatMap((hour) => hour.slices.map((slice) => slice.provider)),
    )
    expect([...seen].sort()).toEqual(['claude', 'codex'])
    for (const provider of ['claude', 'codex'] as const) {
      const scoped = buildDayReport(db, { ...ALL, provider })
      const fromAll = report.byHour
        .flatMap((hour) => hour.slices)
        .filter((slice) => slice.provider === provider)
        .reduce((sum, slice) => sum + slice.tokens, 0)
      expect(fromAll).toBe(scoped.totals.total.value)
    }
  })

  /**
   * Ловит потерянное «названия нет»: подстановка «без названия» в сборке
   * сделала бы безымянную задачу неотличимой от названной так, и второй вид
   * строки исчез бы из данных.
   */
  it('у безымянной задачи название — null, а не подставленная строка', () => {
    const report = buildDayReport(db, ALL)
    expect(report.tasks.length).toBeGreaterThan(0)
    for (const task of report.tasks) {
      expect(task.title === null || task.title.length > 0).toBe(true)
      expect(task.title).not.toBe('без названия')
    }
    expect(report.tasks.some((task) => task.title === null)).toBe(true)
  })

  /**
   * Ловит список детей, потерянный по дороге в контракт (3.5): ядро сводит
   * сабагента в родителя с 3.4, но до окна доезжал только его расход — из чего
   * строка сложилась, спросить было негде.
   */
  it('сабагент доезжает до строки ленты списком, а не только расходом', () => {
    const report = buildDayReport(db, ALL)
    const parent = report.tasks.find(
      (task) => task.sessionId === '92cc27dc-193d-4c2c-aef1-843d7d41aeab',
    )

    expect(parent?.children?.map((child) => child.sessionId)).toEqual(['a6bf337b0067775dd'])
    expect(parent?.children?.[0]?.agentType).toBe('general-purpose')
    // Ребёнок живёт внутри родителя, а не рядом с ним: иначе его расход
    // окажется на экране дважды — своей строкой и внутри родительской.
    expect(report.tasks.some((task) => task.sessionId === 'a6bf337b0067775dd')).toBe(false)
    expect(report.tasks.filter((task) => task.children !== undefined)).toHaveLength(1)
  })

  /**
   * Ловит разворачивание, забывшее вычесть детей из родителя: сумма строк
   * обязана сойтись с шапкой **в обоих** режимах, иначе одна и та же тысяча
   * токенов покажется и в строке ребёнка, и в строке родителя.
   */
  it('развёрнутые сабагенты не двоят расход и не пропадают', () => {
    const folded = buildDayReport(db, ALL)
    const spread = buildDayReport(db, { ...ALL, foldSubagents: false })

    expect(spread.totals.total.value).toBe(folded.totals.total.value)
    expect(spread.tasks.reduce((sum, task) => sum + task.tokens.value, 0)).toBe(
      spread.totals.total.value,
    )
    expect(spread.tasks).toHaveLength(folded.tasks.length + 1)
    expect(spread.tasks.some((task) => task.sessionId === 'a6bf337b0067775dd')).toBe(true)
    expect(spread.tasks.every((task) => task.children === undefined)).toBe(true)
  })

  /**
   * Ловит хвост проектов, покрашенный в чей-то цвет, и именованную строку без
   * провайдера: первое приписывает расход не тому, второе оставляет полосу
   * серой там, где ответ известен.
   */
  it('хвост проектов идёт последним, без провайдера и с числом свёрнутых', () => {
    const report = buildDayReport(db, ALL)
    const tail = report.byProject.filter((row) => row.folded !== undefined)
    expect(tail.length).toBeLessThanOrEqual(1)
    if (tail.length === 1) {
      expect(tail[0]).toBe(report.byProject.at(-1))
      expect(tail[0]!.provider).toBeNull()
      expect(tail[0]!.folded).toBeGreaterThanOrEqual(1)
    }
    for (const row of report.byProject.filter((value) => value.folded === undefined)) {
      expect(row.project).toBeTruthy()
      expect(row.provider).not.toBeNull()
    }
  })
})

/**
 * Свёртка хвоста — на списках, где хвост есть.
 *
 * На восьми фикстурах задач семь и все дорогие, поэтому проверять правило на
 * них значит проверять пустоту: любое правило даст `null`. Список здесь
 * синтетический сознательно — правило чистое, входом ему служат только суммы.
 */
describe('foldTail', () => {
  const list = (...values: number[]) =>
    values.map(
      (value, index) =>
        ({
          sessionId: `s${index}`,
          title: `t${index}`,
          project: 'p',
          provider: 'claude',
          startedAt: 0,
          endedAt: 0,
          requests: 1,
          toolCalls: 0,
          tokens: { value, confidence: 'exact' },
        }) satisfies TaskRow,
    )

  /**
   * Ловит границу, уехавшую на строку: спрятанная строка дороже порога и
   * оставленная дешевле выглядят одинаково нормально.
   */
  it('режет ровно там, где кончаются строки не дешевле порога', () => {
    // Итог 1000: порог 1% — это 10, и первым его не проходит 9.
    const tasks = list(400, 300, 120, 60, 40, 30, 20, 11, 9, 5, 3, 2)
    const folded = foldTail(tasks, 'tokens')
    expect(folded).toEqual({ from: 8, belowTokens: 10 })
    for (const [index, task] of tasks.entries()) {
      expect(task.tokens.value >= folded!.belowTokens, `строка ${index}`).toBe(index < folded!.from)
    }
  })

  /**
   * Ловит свёртку, пережившую смену сортировки: «ниже 4M» на хронологическом
   * списке означало бы дыры посреди ленты — строка есть, следующая свёрнута,
   * третья снова есть.
   */
  it('на любой сортировке кроме расхода хвоста нет', () => {
    const tasks = list(400, 300, 120, 60, 40, 30, 20, 11, 9, 5, 3, 2)
    expect(foldTail(tasks, 'tokens')).not.toBeNull()
    expect(foldTail(tasks, 'started')).toBeNull()
    expect(foldTail(tasks, 'requests')).toBeNull()
  })

  /**
   * Ловит свёртку, съедающую весь список: на дне из одной большой задачи и
   * россыпи мелких порог перешагивает первая же строка, и лента осталась бы
   * пустой с подписью «и ещё 20 задач».
   */
  it('оставляет верхние строки, даже когда порог их не проходит', () => {
    // Итог 942, порог 9. По порогу свернулось бы всё начиная со второй строки —
    // остаётся пять верхних.
    const folded = foldTail(list(900, 9, 8, 7, 6, 5, 4, 3), 'tokens')
    expect(folded).toEqual({ from: 5, belowTokens: 9 })
  })

  /**
   * Ловит свёртку ради одной строки: подпись «и ещё 1 задача» занимает столько
   * же места, сколько сама задача, и прячет её ни за чем.
   */
  it('не сворачивает хвост короче двух строк и пустой список', () => {
    expect(foldTail(list(400, 300, 120, 60, 40, 30, 20, 11, 1), 'tokens')).toBeNull()
    expect(foldTail(list(100, 100, 100), 'tokens')).toBeNull()
    expect(foldTail([], 'tokens')).toBeNull()
    expect(foldTail(list(0, 0), 'tokens')).toBeNull()
  })
})
