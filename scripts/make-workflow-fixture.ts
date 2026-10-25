/**
 * Сборка эталона `workflowReport` (9.3) — `fixtures/workflow/`.
 *
 *     node --experimental-strip-types scripts/make-workflow-fixture.ts
 *
 * Как и у матрицы (8.1), это не срез живых логов: числа придуманы так, чтобы
 * окна считались в уме, и разложены по таблицам в `fixtures/workflow/README.md`.
 * Скрипт только раскладывает их по записям нужного формата: 13 корневых сессий
 * Claude, 30 сабагентов рядом с ними (`<корень>.subagents/agent-<id>.jsonl` и
 * `.meta.json`) и одна сессия Codex.
 *
 * **`expected.json` посчитан человеком и этим скриптом не пишется.** Соберись он
 * выводом реализации — эталон подтвердил бы и среднее долей вместо деления
 * сумм, и «правки до исполнителя» в числителе: числа вышли бы, просто не те.
 *
 * ## Как устроен запрос
 *
 * Расход сессии задан списком `total` по запросам, и каждый запрос раскладывается
 * по одному правилу, чтобы сумма была видна без калькулятора:
 *
 * - `input = 10`, `output = 40`, остальное — кэш;
 * - первый запрос пишет остаток в `cache_write`, `cache_read = 0`;
 * - каждый следующий читает всё, что лежало в кэше до него
 *   (`cache_read = cache_read + cache_write` предыдущего), а недостающее пишет —
 *   цепочка цела, восстановленных запросов нет;
 * - единственное исключение — `cr` у запроса `b3-exec`: чтение больше записанного
 *   рвёт цепочку, и парсер вставляет между запросами восстановленный (1.3).
 *
 * Итоги запросов в сессии не убывают (контекст растёт), поэтому остаток никогда
 * не уходит в минус.
 */
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const dir = join(import.meta.dirname, '..', 'fixtures', 'workflow')
mkdirSync(dir, { recursive: true })

// Только то, что пишет этот скрипт: README.md и expected.json — руками.
for (const name of readdirSync(dir)) {
  if (/\.jsonl$|\.subagents$/.test(name)) rmSync(join(dir, name), { recursive: true, force: true })
}

const FILLER = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor '
function pad(n: number): string {
  return FILLER.repeat(Math.ceil(n / FILLER.length)).slice(0, n)
}

// ── Описание сессий ───────────────────────────────────────────────────────

/**
 * Вызовы запроса — слова через пробел: `R` Read, `W` Write, `E` Edit, `B` Bash,
 * `G` Grep. После буквы — необязательное `@имя` (путь файла, иначе у каждого
 * вызова свой) и суффикс статуса результата:
 *
 * - нет суффикса — результат без ключа `is_error` (успех: правило 30);
 * - `~` — явный `is_error: false` (так пишет Bash);
 * - `!` — `is_error: true`;
 * - `?` — результата нет вовсе (статус `NULL`).
 */
interface Req {
  /** Секунд от старта сессии (метка первой строки запроса). */
  at: number
  /** `input + output + cache_write + cache_read` запроса. */
  total: number
  calls?: string
  /** Принудительное `cache_read`: больше, чем лежало в кэше, — разрыв цепочки. */
  cr?: number
}

interface Session {
  id: string
  /** Корень дерева. У корня совпадает с `id`. */
  root: string
  /** `agentType` из `.meta.json`; `null` — корневая сессия. */
  type: string | null
  /** Каталог, из которого запущена сессия: из него берётся проект. */
  cwd: string
  /** `YYYY-MM-DDTHH:MM:SS` UTC, метка первого запроса. */
  start: string
  reqs: Req[]
  /** Последний текстовый блок (у сабагентов); `undefined` — текста в сессии нет. */
  head?: string
  /** Реплика в первом запросе: последняя запись должна её перебить. */
  early?: string
  model?: string
}

const ALPHA = '/work/alpha'
const BETA = '/work/beta'
const GAMMA = '/work/gamma'

const OPUS = 'claude-opus-5'
const SONNET = 'claude-sonnet-5'

const sessions: Session[] = [
  // ── a1 · alpha · 1 сентября ─ планировщик, исполнитель, ревьюер «с оговорками»
  {
    id: 'a1',
    root: 'a1',
    type: null,
    cwd: ALPHA,
    start: '2026-09-01T10:00:00',
    reqs: [
      { at: 0, total: 1000, calls: 'R W W' },
      { at: 3000, total: 2000, calls: 'B~ E E' },
    ],
  },
  {
    id: 'a1-plan',
    root: 'a1',
    type: 'plan-opus',
    cwd: ALPHA,
    start: '2026-09-01T10:05:00',
    reqs: [{ at: 0, total: 500, calls: 'W' }],
    head: 'План готов: три шага.',
  },
  {
    id: 'a1-exec',
    root: 'a1',
    type: 'exec-sonnet-high',
    cwd: ALPHA,
    start: '2026-09-01T10:15:00',
    reqs: [
      { at: 0, total: 1500, calls: 'R R' },
      // `a.ts` правится дважды: строк `tool_files` четыре, разных файлов три.
      { at: 300, total: 2000, calls: 'E@a E@b B!' },
      { at: 600, total: 2500, calls: 'E@a E@c' },
    ],
    head: 'Сделано по плану, тесты зелёные.',
    model: SONNET,
  },
  {
    id: 'a1-rev',
    root: 'a1',
    type: 'review-opus',
    cwd: ALPHA,
    start: '2026-09-01T10:40:00',
    reqs: [
      { at: 0, total: 500, calls: 'R R' },
      { at: 120, total: 500, calls: 'B~' },
    ],
    early: 'Сверяю дифф с промтом.',
    head: '**Принят с оговорками.** Замечания: имя переменной, пустая строка.',
  },

  // ── b1 · beta · 2 сентября ─ исполнитель с «оговорками» в своём отчёте
  {
    id: 'b1',
    root: 'b1',
    type: null,
    cwd: BETA,
    start: '2026-09-02T10:00:00',
    reqs: [
      { at: 0, total: 1000, calls: 'R W' },
      { at: 2700, total: 1000, calls: 'B~' },
    ],
  },
  {
    id: 'b1-exec',
    root: 'b1',
    type: 'exec-sonnet-medium',
    cwd: BETA,
    start: '2026-09-02T10:10:00',
    reqs: [
      { at: 0, total: 1000, calls: 'R' },
      { at: 300, total: 1500, calls: 'E E E! E E' },
      { at: 600, total: 1500, calls: 'E E! E E E' },
    ],
    // Вердикт считается у ревьюеров. Слова «с оговорками» в отчёте исполнителя —
    // не приёмка, и в вердикты цикла не попадают.
    head: 'Сделано с оговорками: тесты на Windows не запускал.',
    model: SONNET,
  },
  {
    id: 'b1-rev',
    root: 'b1',
    type: 'review-opus',
    cwd: BETA,
    start: '2026-09-02T10:30:00',
    reqs: [
      { at: 0, total: 500, calls: 'R' },
      { at: 120, total: 1000, calls: 'E E' },
    ],
    head: '**Принят с оговорками.** Два мелких замечания поправил сам.',
  },

  // ── a2 · alpha · 3 сентября ─ «не принят»; ревьюер запущен из чужого каталога
  {
    id: 'a2',
    root: 'a2',
    type: null,
    cwd: ALPHA,
    start: '2026-09-03T10:00:00',
    reqs: [
      { at: 0, total: 1500, calls: 'R' },
      { at: 3000, total: 2500, calls: 'E E B~' },
    ],
  },
  {
    id: 'a2-exec',
    root: 'a2',
    type: 'exec-opus-high',
    cwd: ALPHA,
    start: '2026-09-03T10:10:00',
    reqs: [
      { at: 0, total: 1000, calls: 'R' },
      { at: 300, total: 1000, calls: 'E E' },
    ],
    head: 'Готово.',
  },
  {
    // Проект сабагента — beta, корня — alpha: `scope.project` идёт за корнем.
    id: 'a2-rev',
    root: 'a2',
    type: 'review-opus',
    cwd: BETA,
    start: '2026-09-03T10:30:00',
    reqs: [
      { at: 0, total: 1500, calls: 'R R B!' },
      { at: 180, total: 1500, calls: 'R' },
    ],
    head: '**Не принят.** Тесты не проходят, правки нужны.',
  },

  // ── g1 · gamma · 4 сентября ─ правки только через Bash, у ревьюера нет текста
  {
    id: 'g1',
    root: 'g1',
    type: null,
    cwd: GAMMA,
    start: '2026-09-04T10:00:00',
    reqs: [
      { at: 0, total: 700, calls: 'R' },
      { at: 2400, total: 800, calls: 'B~' },
    ],
  },
  {
    id: 'g1-exec',
    root: 'g1',
    type: 'exec-sonnet-high',
    cwd: GAMMA,
    start: '2026-09-04T10:10:00',
    reqs: [
      { at: 0, total: 1000, calls: 'R B~' },
      { at: 300, total: 1000, calls: 'B~ B~ B!' },
      { at: 600, total: 1000, calls: 'B~' },
    ],
    head: 'Сделано.',
    model: SONNET,
  },
  {
    id: 'g1-rev',
    root: 'g1',
    type: 'review-opus',
    cwd: GAMMA,
    start: '2026-09-04T10:30:00',
    reqs: [{ at: 0, total: 500, calls: 'R B~' }],
  },

  // ── b0 · beta · 5 сентября ─ корень без исполнителя: цикла нет
  {
    id: 'b0',
    root: 'b0',
    type: null,
    cwd: BETA,
    start: '2026-09-05T11:00:00',
    reqs: [
      { at: 0, total: 600, calls: 'R B!' },
      { at: 600, total: 600, calls: 'E' },
    ],
  },
  {
    // `general-purpose` — роль не определена; правит файлы, но исполнителем не
    // становится, а корень от него — циклом.
    id: 'b0-gp',
    root: 'b0',
    type: 'general-purpose',
    cwd: BETA,
    start: '2026-09-05T11:10:00',
    reqs: [
      { at: 0, total: 700, calls: 'R' },
      { at: 60, total: 700, calls: 'E E' },
    ],
    head: 'Готово, поправил два файла.',
  },
  {
    id: 'b0-expl',
    root: 'b0',
    type: 'Explore',
    cwd: BETA,
    start: '2026-09-05T11:20:00',
    reqs: [{ at: 0, total: 400, calls: 'G R' }],
    head: 'Нашёл: один файл.',
  },

  // ── a3 · alpha · 7 сентября ─ ревьюер — general-purpose (unknown), граница `>=`
  {
    // Второй запрос корня ровно в момент старта исполнителя (10:10:00.000):
    // запись на границе входит в `after`.
    id: 'a3',
    root: 'a3',
    type: null,
    cwd: ALPHA,
    start: '2026-09-07T10:00:00',
    reqs: [
      { at: 0, total: 1000, calls: 'R W' },
      { at: 600, total: 1500, calls: 'E' },
    ],
  },
  {
    id: 'a3-exec',
    root: 'a3',
    type: 'exec-sonnet-high',
    cwd: ALPHA,
    start: '2026-09-07T10:10:00',
    reqs: [
      { at: 0, total: 1500, calls: 'R R' },
      { at: 300, total: 1750, calls: 'E E E' },
      { at: 600, total: 1750, calls: 'E E E B!' },
    ],
    head: 'Все шесть файлов обновлены.',
    model: SONNET,
  },
  {
    // Пишет «Принят» в отчёте, но роль не определена: это не вердикт цикла.
    id: 'a3-gp',
    root: 'a3',
    type: 'general-purpose',
    cwd: ALPHA,
    start: '2026-09-07T10:30:00',
    reqs: [
      { at: 0, total: 1000, calls: 'R E' },
      { at: 240, total: 1000, calls: 'E E B?' },
    ],
    head: '**Принят.** Правки применил.',
  },

  // ── b2 · beta · 8 сентября, 10:00 ─ два исполнителя; пересекается с a4
  {
    id: 'b2',
    root: 'b2',
    type: null,
    cwd: BETA,
    start: '2026-09-08T10:00:00',
    reqs: [
      { at: 0, total: 1000, calls: 'R W' },
      // Между стартами исполнителей (10:10 и 10:40): после первого — значит `after`.
      { at: 1500, total: 1250, calls: 'E' },
      { at: 4200, total: 1250, calls: 'B~' },
    ],
  },
  {
    id: 'b2-exec1',
    root: 'b2',
    type: 'exec-sonnet-high',
    cwd: BETA,
    start: '2026-09-08T10:10:00',
    reqs: [
      { at: 0, total: 1000, calls: 'R' },
      { at: 300, total: 1000, calls: 'E E' },
      { at: 600, total: 1000, calls: 'E' },
    ],
    head: 'Первая половина готова.',
    model: SONNET,
  },
  {
    // Проект сабагента — alpha, корня — beta (см. a2-rev с обратным знаком).
    id: 'b2-exec2',
    root: 'b2',
    type: 'exec-sonnet-high',
    cwd: ALPHA,
    start: '2026-09-08T10:40:00',
    reqs: [
      { at: 0, total: 1250, calls: 'R R' },
      { at: 300, total: 1250, calls: 'E E E' },
      { at: 600, total: 1500, calls: 'E E B!' },
    ],
    head: 'Вторая половина готова.',
    model: SONNET,
  },
  {
    // Отказ стоит в теле отчёта, а не в первой строке: вердикт — «принят».
    id: 'b2-rev',
    root: 'b2',
    type: 'review-opus',
    cwd: BETA,
    start: '2026-09-08T11:00:00',
    reqs: [
      { at: 0, total: 500, calls: 'R R' },
      { at: 180, total: 500, calls: 'E' },
    ],
    head:
      '**Принят.** Замечаний нет.\n\nПо ходу работы: решение по кэшу не принято, ' +
      'отдельный вопрос; вердикт «не принят» относится к нему, а не к этапу.',
  },

  // ── a4 · alpha · 8 сентября, 10:30 ─ разведка, ревьюер «принят»
  {
    id: 'a4',
    root: 'a4',
    type: null,
    cwd: ALPHA,
    start: '2026-09-08T10:30:00',
    reqs: [
      { at: 0, total: 1000, calls: 'R' },
      { at: 3600, total: 1000, calls: 'E E' },
    ],
  },
  {
    id: 'a4-expl',
    root: 'a4',
    type: 'Explore',
    cwd: ALPHA,
    start: '2026-09-08T10:35:00',
    reqs: [{ at: 0, total: 300, calls: 'G R' }],
    head: 'Нашёл три файла.',
  },
  {
    id: 'a4-exec',
    root: 'a4',
    type: 'exec-sonnet-high',
    cwd: ALPHA,
    start: '2026-09-08T10:50:00',
    reqs: [
      { at: 0, total: 1500, calls: 'R R' },
      { at: 300, total: 2250, calls: 'E E E E' },
      { at: 600, total: 2250, calls: 'E E E E' },
    ],
    head: 'Восемь правок, готово.',
    model: SONNET,
  },
  {
    id: 'a4-rev',
    root: 'a4',
    type: 'review-opus',
    cwd: ALPHA,
    start: '2026-09-08T11:20:00',
    reqs: [
      { at: 0, total: 700, calls: 'R' },
      { at: 120, total: 800, calls: 'E' },
    ],
    head: '**Принят.** Один файл поправил сам.',
  },

  // ── g2 · gamma · 10 сентября
  {
    id: 'g2',
    root: 'g2',
    type: null,
    cwd: GAMMA,
    start: '2026-09-10T10:00:00',
    reqs: [
      { at: 0, total: 500, calls: 'R' },
      { at: 1800, total: 500, calls: 'B~' },
    ],
  },
  {
    id: 'g2-exec',
    root: 'g2',
    type: 'exec-sonnet-max',
    cwd: GAMMA,
    start: '2026-09-10T10:10:00',
    reqs: [
      { at: 0, total: 800, calls: 'R B~' },
      { at: 300, total: 800, calls: 'B~ B! B~' },
      { at: 600, total: 900, calls: 'B~' },
    ],
    head: 'Готово.',
    model: SONNET,
  },
  {
    id: 'g2-rev',
    root: 'g2',
    type: 'review-opus',
    cwd: GAMMA,
    start: '2026-09-10T10:40:00',
    reqs: [{ at: 0, total: 500, calls: 'R B~' }],
    head: '**Принят.** Замечаний нет.',
  },

  // ── b3 · beta · 11 сентября ─ восстановленный запрос, планировщик правит после старта
  {
    id: 'b3',
    root: 'b3',
    type: null,
    cwd: BETA,
    start: '2026-09-11T10:00:00',
    reqs: [
      { at: 0, total: 1000, calls: 'R W W W' },
      { at: 3600, total: 2000, calls: 'B~' },
    ],
  },
  {
    id: 'b3-plan',
    root: 'b3',
    type: 'plan-opus',
    cwd: BETA,
    start: '2026-09-11T10:05:00',
    reqs: [
      { at: 0, total: 500, calls: 'R' },
      // 10:35 — уже после старта исполнителя (10:20): перепланирование.
      { at: 1800, total: 500, calls: 'W W' },
    ],
    head: 'План обновлён.',
  },
  {
    // Чтение кэша второго запроса — 900 при записанных 450: между запросами
    // ложится восстановленный (cache_write 450, cache_read 450, итого 900).
    id: 'b3-exec',
    root: 'b3',
    type: 'exec-sonnet-high',
    cwd: BETA,
    start: '2026-09-11T10:20:00',
    reqs: [
      { at: 0, total: 500, calls: 'R' },
      { at: 300, total: 2600, calls: 'E E! E E E E!', cr: 900 },
      { at: 600, total: 6000, calls: 'E E E E E E?' },
    ],
    head: 'Двенадцать правок, тесты зелёные.',
    model: SONNET,
  },
  {
    id: 'b3-rev',
    root: 'b3',
    type: 'review-opus',
    cwd: BETA,
    start: '2026-09-11T10:50:00',
    reqs: [
      { at: 0, total: 1000, calls: 'R R' },
      { at: 120, total: 1000, calls: 'E' },
    ],
    head: '**Принят с оговорками.** Один файл поправил сам.',
  },

  // ── a5 · alpha · 14 сентября ─ короткий исполнитель, основную работу сделал корень
  {
    id: 'a5',
    root: 'a5',
    type: null,
    cwd: ALPHA,
    start: '2026-09-14T10:00:00',
    reqs: [
      { at: 0, total: 2000, calls: 'R B~' },
      { at: 3600, total: 3000, calls: 'E E E B~' },
    ],
  },
  {
    id: 'a5-exec',
    root: 'a5',
    type: 'exec-sonnet-medium',
    cwd: ALPHA,
    start: '2026-09-14T10:30:00',
    reqs: [
      { at: 0, total: 250, calls: 'R!' },
      { at: 60, total: 250, calls: 'E' },
    ],
    head: 'Одна правка.',
    model: SONNET,
  },
  {
    // Текст есть, вердикта в нём нет.
    id: 'a5-rev',
    root: 'a5',
    type: 'review-opus',
    cwd: ALPHA,
    start: '2026-09-14T11:10:00',
    reqs: [{ at: 0, total: 800, calls: 'R' }],
    head: 'Чисто. Коммичу как есть.',
  },

  // ── g3 · gamma · 15 сентября, 10:00
  {
    id: 'g3',
    root: 'g3',
    type: null,
    cwd: GAMMA,
    start: '2026-09-15T10:00:00',
    reqs: [
      { at: 0, total: 500, calls: 'R B~' },
      { at: 1200, total: 500, calls: 'B~' },
    ],
  },
  {
    id: 'g3-exec',
    root: 'g3',
    type: 'exec-sonnet-medium',
    cwd: GAMMA,
    start: '2026-09-15T10:10:00',
    reqs: [
      { at: 0, total: 700, calls: 'R B~' },
      { at: 240, total: 1300, calls: 'B~ B~' },
    ],
    head: 'Готово.',
    model: SONNET,
  },
  {
    id: 'g3-rev',
    root: 'g3',
    type: 'review-opus',
    cwd: GAMMA,
    start: '2026-09-15T10:40:00',
    reqs: [{ at: 0, total: 500, calls: 'R B~' }],
    head: '**Не принят.** Тесты красные.',
  },

  // ── a6 · alpha · 16 сентября ─ ревьюер — general-purpose, правит после старта
  {
    id: 'a6',
    root: 'a6',
    type: null,
    cwd: ALPHA,
    start: '2026-09-16T10:00:00',
    reqs: [
      { at: 0, total: 1000, calls: 'R W' },
      { at: 3600, total: 1000, calls: 'B~' },
    ],
  },
  {
    id: 'a6-exec',
    root: 'a6',
    type: 'exec-sonnet-high',
    cwd: ALPHA,
    start: '2026-09-16T10:10:00',
    reqs: [
      { at: 0, total: 1500, calls: 'R R' },
      { at: 300, total: 1500, calls: 'E E E E E' },
      { at: 600, total: 1500, calls: 'E E E! E B~' },
    ],
    head: 'Девять правок.',
    model: SONNET,
  },
  {
    id: 'a6-gp',
    root: 'a6',
    type: 'general-purpose',
    cwd: ALPHA,
    start: '2026-09-16T10:40:00',
    reqs: [
      { at: 0, total: 500, calls: 'R R' },
      { at: 180, total: 500, calls: 'E' },
    ],
    head: '**Принят.** Готово к коммиту.',
  },
]

// ── Запись Claude ─────────────────────────────────────────────────────────

const TOOLS: Record<string, string> = { R: 'Read', W: 'Write', E: 'Edit', B: 'Bash', G: 'Grep' }

interface Call {
  letter: string
  path: string
  status: '' | '~' | '!' | '?'
}

function parseCalls(session: Session, request: number, calls: string | undefined): Call[] {
  if (calls === undefined) return []
  return calls.split(' ').map((word, index) => {
    const match = /^([RWEBG])(?:@([\w-]+))?([~!?])?$/.exec(word)
    if (!match) throw new Error(`${session.id}: не разобрать вызов «${word}»`)
    const letter = match[1]!
    const name = match[2] ?? `${session.id}-${request}${index}`
    const path = letter === 'W' ? `docs/${name}.md` : `src/${name}.ts`
    return { letter, path, status: (match[3] ?? '') as Call['status'] }
  })
}

function stamp(start: string, offsetSeconds: number): string {
  return new Date(Date.parse(`${start}.000Z`) + offsetSeconds * 1000).toISOString()
}

function claudeLines(session: Session): string[] {
  const subagent = session.type !== null
  const lines: string[] = []
  let uuid = 0
  const next = (): string =>
    `${session.id.replace(/\W/g, '').padEnd(8, '0').slice(0, 8)}-0000-4000-8000-${String(++uuid).padStart(12, '0')}`
  const common = {
    isSidechain: subagent,
    ...(subagent ? { agentId: session.id } : {}),
    userType: 'external',
    cwd: session.cwd,
    // У сабагента внутри файла лежит `sessionId` родителя (правило 4): дерево
    // собирается по каталогу, а не по этому полю.
    sessionId: session.root,
    version: '2.1.223',
    gitBranch: 'main',
    entrypoint: 'cli',
  }
  let parent: string | null = null
  const push = (record: Record<string, unknown>): void => {
    const id = next()
    lines.push(JSON.stringify({ ...common, parentUuid: parent, uuid: id, ...record }))
    parent = id
  }

  push({
    timestamp: stamp(session.start, -2),
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: pad(200) }] },
  })

  let previousCr = 0
  let previousCw = 0
  session.reqs.forEach((req, j) => {
    const cr = j === 0 ? 0 : (req.cr ?? previousCr + previousCw)
    const cw = req.total - 50 - cr
    if (cw < 0) throw new Error(`${session.id}: запрос ${j} короче своего кэша`)
    previousCr = cr
    previousCw = cw

    const calls = parseCalls(session, j, req.calls)
    const last = j === session.reqs.length - 1
    const content: Record<string, unknown>[] = []
    if (j === 0 && session.early !== undefined) content.push({ type: 'text', text: session.early })
    if (last && session.head !== undefined) content.push({ type: 'text', text: session.head })
    calls.forEach((call, index) => {
      const input: Record<string, unknown> =
        call.letter === 'B'
          ? { command: 'true' }
          : call.letter === 'G'
            ? { pattern: 'lorem' }
            : call.letter === 'W'
              ? { file_path: call.path, content: 'lorem' }
              : call.letter === 'E'
                ? { file_path: call.path, old_string: 'lorem', new_string: 'ipsum' }
                : { file_path: call.path }
      content.push({
        type: 'tool_use',
        id: `toolu_${session.id}_${j}_${index}`,
        name: TOOLS[call.letter],
        input,
      })
    })

    push({
      timestamp: stamp(session.start, req.at),
      type: 'assistant',
      requestId: `req_${session.id}_${j}`,
      message: {
        id: `msg_${session.id}_${j}`,
        type: 'message',
        role: 'assistant',
        model: session.model ?? OPUS,
        content,
        stop_reason: last ? 'end_turn' : 'tool_use',
        usage: {
          input_tokens: 10,
          cache_creation_input_tokens: cw,
          cache_read_input_tokens: cr,
          output_tokens: 40,
          cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: cw },
        },
      },
    })

    const results = calls
      .map((call, index) => ({ call, id: `toolu_${session.id}_${j}_${index}` }))
      .filter(({ call }) => call.status !== '?')
      .map(({ call, id }) => ({
        type: 'tool_result',
        tool_use_id: id,
        content: 'ok',
        ...(call.status === '!'
          ? { is_error: true }
          : call.status === '~'
            ? { is_error: false }
            : {}),
      }))
    if (results.length > 0) {
      push({
        timestamp: stamp(session.start, req.at + 1),
        type: 'user',
        message: { role: 'user', content: results },
      })
    }
  })

  return lines
}

// ── Codex: x1, проект alpha, 15 сентября в 15:00 ──────────────────────────

/** Три запроса, пять вызовов `exec_command`: статуса у Codex нет ни у одного. */
function codexLines(): string[] {
  const lines: string[] = []
  let ts = Date.parse('2026-09-15T15:00:00.000Z')
  const turnId = '019eca75-3333-7000-a000-000000000001'
  const rec = (type: string, payload: unknown, advance = 30_000): void => {
    lines.push(JSON.stringify({ timestamp: new Date(ts).toISOString(), type, payload }))
    ts += advance
  }
  rec('session_meta', {
    id: 'x1',
    timestamp: '2026-09-15T15:00:00.000Z',
    cwd: ALPHA,
    originator: 'codex-tui',
    cli_version: '0.145.0',
    source: 'cli',
    model_provider: 'openai',
    git: { branch: 'main' },
  })
  rec('event_msg', { type: 'task_started', turn_id: turnId, model_context_window: 258_400 })
  rec('turn_context', { turn_id: turnId, model: 'gpt-5.6-sol' })
  rec('event_msg', { type: 'user_message', message: pad(200) })

  const steps = [
    { ctx: 1000, cached: 0, output: 100, calls: 2 },
    { ctx: 1500, cached: 900, output: 150, calls: 2 },
    { ctx: 2000, cached: 1400, output: 200, calls: 1 },
  ]
  const total = { input: 0, cached: 0, output: 0 }
  let call = 0
  steps.forEach((step) => {
    const ids = Array.from({ length: step.calls }, () => `call_x1_${call++}`)
    for (const id of ids) {
      rec(
        'response_item',
        { type: 'function_call', name: 'exec_command', arguments: '{"cmd":"true"}', call_id: id },
        1000,
      )
    }
    for (const id of ids) {
      rec('response_item', { type: 'function_call_output', call_id: id, output: 'ok' }, 1000)
    }
    total.input += step.ctx
    total.cached += step.cached
    total.output += step.output
    rec('event_msg', {
      type: 'token_count',
      info: {
        model_context_window: 258_400,
        last_token_usage: {
          input_tokens: step.ctx,
          cached_input_tokens: step.cached,
          output_tokens: step.output,
          reasoning_output_tokens: 0,
          total_tokens: step.ctx + step.output,
        },
        total_token_usage: {
          input_tokens: total.input,
          cached_input_tokens: total.cached,
          output_tokens: total.output,
          reasoning_output_tokens: 0,
          total_tokens: total.input + total.output,
        },
      },
    })
  })
  return lines
}

// ── Раскладка по файлам ───────────────────────────────────────────────────

const written: string[] = []
for (const session of sessions) {
  if (session.id === session.root) {
    writeFileSync(join(dir, `${session.id}.jsonl`), `${claudeLines(session).join('\n')}\n`)
    written.push(`${session.id}.jsonl`)
    continue
  }
  const sub = join(dir, `${session.root}.subagents`)
  mkdirSync(sub, { recursive: true })
  writeFileSync(join(sub, `agent-${session.id}.jsonl`), `${claudeLines(session).join('\n')}\n`)
  writeFileSync(
    join(sub, `agent-${session.id}.meta.json`),
    `${JSON.stringify({ agentType: session.type, description: 'lorem ipsum' }, null, 2)}\n`,
  )
}
writeFileSync(join(dir, 'codex-x1.jsonl'), `${codexLines().join('\n')}\n`)
written.push('codex-x1.jsonl')

const roots = sessions.filter((session) => session.id === session.root).length
console.log(
  `fixtures/workflow/ — корней Claude ${roots}, сабагентов ${sessions.length - roots}, Codex 1: ${written.join(', ')}`,
)
