/**
 * Русский каталог — **единственный источник ключей** (3.8).
 *
 * Английский типизирован как `typeof ru`, поэтому недостающий перевод не
 * доживает до экрана: он не собирается. Обратная защита тоже есть — лишний ключ
 * в `en` тип не пропустит, а значит каталоги не разъедутся ни в одну сторону.
 *
 * Термины берутся из глоссария (`docs/roadmap/3.8-glossary.md`), а не
 * придумываются на месте: половина слов продукта уже написана провайдером в
 * логах, и второй словарь поверх существующего врёт не хуже цифры.
 *
 * Множественное число — механикой i18next (`_one/_few/_many`), а не своими
 * массивами форм: правила русского счёта на 11 и 111 разные, и второй набор
 * правил однажды разойдётся с первым молча.
 */
export const ru = {
  /** Состояния агента — попап, окно, CLI. */
  state: {
    thinking: 'думает',
    waiting: 'ждёт ответа',
    silent: 'молчит',
    finished: 'завершился',
    finishedAgo: 'завершился {{ago}}',
    notSeen: 'не видно',
    turnHuman: 'ход у человека',
    turnModel: 'ход у модели',
    asked: 'спросил',
    askedTool: 'спросил (инструмент)',
    liveProcess: 'процесс',
    liveSilence: 'тишина',
    waitingShort: 'ждёт',
    askedWith: 'спросил ({{tool}})',
    tool: 'инструмент',
  },

  /** Окна лимита. */
  limit: {
    fiveHour: '5-часовое окно',
    weekly: 'недельное окно',
    monthly: 'месячное окно',
    other: 'окно лимита',
    unknownPercent: 'процент недоступен',
    resetsIn: 'сброс через {{span}}',
    untilCap: '{{reset}} · ≈{{span}} до упора',
    idleWindow: 'окно закроется через {{span}} — пауза его не расходует',
    unknown: 'лимит неизвестен',
    trayPercent: 'лимит {{percent}}%',
  },

  /** Вкладки и шапка главного окна. */
  window: {
    tabToday: 'Сегодня',
    tabBreakdown: 'Развёртка',
    tabHistory: 'История',
    tabSettings: 'Настройки',
    placeholder: 'этот экран появится в {{stage}}',
    active_one: '{{count}} активный',
    active_few: '{{count}} активных',
    active_many: '{{count}} активных',
  },

  /** Попап трея. */
  popup: {
    working: 'Сейчас работают',
    limits: 'Лимиты',
    estimate: '≈ оценка',
    updatedAgo: 'обновлено {{ago}}',
    readError: 'Ошибка чтения',
    brokenLogs: 'Не читаются логи {{names}}',
    setPath: 'Указать путь',
    retry: 'Повторить',
    neverRan: 'Агенты ещё не запускались',
    neverRanHint: 'Запустите Claude Code или Codex — Agentmeter подхватит сессию сам, за пару секунд.',
    indexing: 'Первичное индексирование',
    indexingHint:
      'Читаем только локальные логи. Сегодняшний день уже доступен — история дособерётся в фоне.',
    megabytes: '{{done}} / {{total}} МБ',
    footerToday: 'Сегодня',
    openWindow: 'Открыть окно ⌘⏎',
    // Выделенный кусок — подстановка `agent`: сама фраза остаётся целой, иначе
    // порядок слов в переводе задаёт разметка, а не язык.
    idleLast: 'Никого. Последний — {{agent}}, {{ago}}',
    and: ' и ',
    context: 'контекст {{sign}}{{percent}}% · {{used}} из {{sign}}{{window}}',
    etaSeconds: '≈ {{seconds}} с',
    nobody: 'никто не работает',
    agents_one: '{{count}} агент',
    agents_few: '{{count}} агента',
    agents_many: '{{count}} агентов',
  },

  /** Вкладка «Сегодня»: лента, разрезы, три пустых экрана. */
  today: {
    byHour: 'Расход по часам',
    byProject: 'По проектам',
    sort: 'Сортировка',
    sortPrefix: 'сортировка:',
    sortTokens: 'по расходу ↓',
    sortStarted: 'по времени ↓',
    sortRequests: 'по запросам ↓',
    filterAll: 'все',
    // Шапка ленты, строка 614 макета: пять колонок фиксированной ширины.
    columnTask: 'Задача',
    columnProject: 'Проект · ветка',
    columnStarted: 'Начало',
    columnRequests: 'Запросы',
    columnTokens: 'Токены',
    tokensWord: 'токенов',
    firstPrompt: 'первый промпт: «{{prompt}}»',
    loading: 'Загружаем ленту…',
    emptyIndex: 'Первичное индексирование — лента появится после чтения логов',
    emptyDay: 'Сегодня задач не было',
    emptyFilter: 'По выбранному фильтру задач нет',
    untitled: 'без названия',
    projects_one: '+ {{count}} проект',
    projects_few: '+ {{count}} проекта',
    projects_many: '+ {{count}} проектов',
    foldedTail_one: 'и ещё {{count}} задача ниже {{tokens}} — свернуто',
    foldedTail_few: 'и ещё {{count}} задачи ниже {{tokens}} — свернуто',
    foldedTail_many: 'и ещё {{count}} задач ниже {{tokens}} — свернуто',
    sessions_one: '{{count}} сессия',
    sessions_few: '{{count}} сессии',
    sessions_many: '{{count}} сессий',
    projectsPlain_one: '{{count}} проект',
    projectsPlain_few: '{{count}} проекта',
    projectsPlain_many: '{{count}} проектов',
    requests_one: '{{count}} запрос',
    requests_few: '{{count}} запроса',
    requests_many: '{{count}} запросов',
    subagents_one: '{{count}} сабагент',
    subagents_few: '{{count}} сабагента',
    subagents_many: '{{count}} сабагентов',
  },

  /** Карточка задачи — раздел 4 макета. */
  card: {
    untitled: 'Без названия',
    timeline: 'Таймлайн запросов · высота = токены запроса',
    tokenSplit: 'Токены по типам',
    tools: 'Инструменты в этой задаче',
    files: 'Затронутые файлы · {{count}}',
    subagents: 'Сабагенты · {{count}}',
    subagentUnnamed: 'сабагент',
    dayShare: '{{percent}}% дневного расхода',
  },

  /** Четыре вида токенов. Слова из глоссария, менять их врозь нельзя. */
  tokens: {
    input: 'свежий ввод',
    cacheWrite: 'запись в кэш',
    cacheRead: 'чтение кэша',
    output: 'вывод',
  },

  /** Оговорки точности — всплывают подсказкой у знака `≈`. */
  caveat: {
    reconstructed: 'часть запросов восстановлена по разрыву цепочки кэша, этап 1.3',
    observedWindow:
      'размер окна Claude в логи не пишется — выведен из наблюдавшегося максимума, этап 2.6',
    split: 'стоимость поделена между вызовами одного запроса, этап 1.6',
    unmeasured: 'часть вызовов измерить нечем — следующего запроса в логе нет, этап 1.6',
  },

  /** Фразы, за которыми стоит суждение. Их собирает main (правило 3.0). */
  note: {
    sourceIntact: 'Данные {{names}} показываются как обычно, ',
    sourceBroken: '{{intact}}цифры {{provider}} за сегодня — неполные.',
    compaction: 'сжатие контекста',
    images_one:
      '{{count}} картинка в результате — плотнее текста в тринадцать раз, {{tokens}} в промпт',
    images_few:
      '{{count}} картинки в результате — плотнее текста в тринадцать раз, {{tokens}} в промпт',
    images_many:
      '{{count}} картинок в результате — плотнее текста в тринадцать раз, {{tokens}} в промпт',
    bigResult: 'большой результат {{tool}} — {{tokens}} в промпт',
    bigResultFile: 'большой результат {{tool}} — {{path}} — {{tokens}} в промпт',
    spread_one: '{{count}} результат инструмента сразу — {{tokens}} в промпт',
    spread_few: '{{count}} результата инструментов сразу — {{tokens}} в промпт',
    spread_many: '{{count}} результатов инструментов сразу — {{tokens}} в промпт',
    compactions_one: '{{count}} сжатие контекста — {{tokens}}',
    compactions_few: '{{count}} сжатия контекста — {{tokens}} вместе',
    compactions_many: '{{count}} сжатий контекста — {{tokens}} вместе',
    costlier_one: '{{count}} запрос дороже прочих — {{tokens}}',
    costlier_few: '{{count}} запроса дороже прочих — {{tokens}} вместе',
    costlier_many: '{{count}} запросов дороже прочих — {{tokens}} вместе',
    // Одна выделенная точка «смешанной» не бывает — форма есть ради полноты:
    // недостающая форма это «1 запросов» на экране, а не отсутствие строки.
    marked_one: '{{count}} запрос выделен — {{tokens}}',
    marked_few: '{{count}} запроса выделены — {{tokens}} вместе',
    marked_many: '{{count}} запросов выделены — {{tokens}} вместе',
    toolImages_one:
      '{{count}} вызов с картинками — они плотнее текста в тринадцать раз, по {{per}} на вызов',
    toolImages_few:
      '{{count}} вызова с картинками — они плотнее текста в тринадцать раз, по {{per}} на вызов',
    toolImages_many:
      '{{count}} вызовов с картинками — они плотнее текста в тринадцать раз, по {{per}} на вызов',
    toolCostly: 'по {{per}} в промпт на вызов при среднем {{average}} — {{tool}} дороже прочих',
    reread_one: 'Кэш перечитывался {{count}} раз{{grew}}.',
    reread_few: 'Кэш перечитывался {{count}} раза{{grew}}.',
    reread_many: 'Кэш перечитывался {{count}} раз{{grew}}.',
    rereadGrew: ' — контекст вырастал до {{peak}}',
  },

  /** Время: «2 мин назад», «1 ч 20 мин». Единицы короткие — места нет. */
  time: {
    secondsAgo: '{{count}} с назад',
    minutesAgo: '{{count}} мин назад',
    hoursAgo: '{{count}} ч назад',
    daysAgo: '{{count}} д назад',
    lessThanMinute: 'меньше минуты',
    minutes: '{{count}} мин',
    hours: '{{count}} ч',
    hoursMinutes: '{{hours}} ч {{minutes}} мин',
    days: '{{count}} д',
    daysHours: '{{days}} д {{hours}} ч',
    perMinute: '{{tokens}}/мин',
    seconds: '{{count}} с',
  },

  /** CLI: заголовки колонок и сообщения команд. */
  cli: {
    emptyIndex: 'индекс пуст, запустите `agentmeter index`',
    emptyRange: 'в выбранном диапазоне записей нет',
    emptyDate: 'за {{date}} записей нет',
    noWindows: 'текущих окон лимита нет',
    nobody: 'сейчас никто не работает',
    agents_one: '{{count}} агент',
    agents_few: '{{count}} агента',
    agents_many: '{{count}} агентов',
    columnTime: 'Время',
    columnTool: 'Инструмент',
    columnMeasured: 'Измерено',
    columnSplit: 'Делёж',
    columnUnknown: 'Неизвестно',
    columnCalls: 'Вызовы',
    columnServer: 'MCP-сервер',
    columnTokens: 'Токены',
    columnRequests: 'Запросы',
    columnSkill: 'Скилл',
    columnAgent: 'Агент',
    columnModel: 'Модель',
    columnProvider: 'Провайдер',
    columnWindow: 'Окно',
    columnSpend: 'Расход',
    columnUntilReset: 'До сброса',
    columnRate: 'Темп',
    columnUntilCap: 'До упора',
    columnBasis: 'Основа',
    columnProject: 'Проект',
    columnState: 'Состояние',
    columnTurn: 'Ход',
    columnLiveness: 'Живость',
    columnWorking: 'В работе',
    columnSilence: 'Тишина',
    columnContext: 'Контекст',
    columnKind: 'Вид',
    columnDetail: 'Деталь',
    columnCount: 'Число',
    basisExact: 'точно',
    basisEstimate: 'оценка',
    noRate: 'темпа нет',
    resetsFirst: 'сбросится раньше',
    windowFiveHour: '5 часов',
    windowWeekly: 'неделя',
    windowMonthly: 'месяц',
    unknownReason: 'неизвестно',
    unavailable: '— ({{reason}})',
    indexPath: 'Индекс: {{path}}',
    schema: 'Схема: {{version}}',
    sources: 'Источники: {{sources}} · сессии: {{sessions}} · запросы: {{requests}}',
    reconstructedSessions: 'Сессии с измеренной поправкой: {{sessions}}',
    calibration: 'Калибровка',
    cacheReadWeight: 'cache_read: {{value}}',
    notCalibrated: '— (не откалиброван, этап 1.9)',
    fiveHourCap: 'пятичасовой потолок: {{value}}',
    weeklyCap: 'недельный потолок: {{value}}',
    notSet: '— (не задан)',
    configProblems: 'Проблемы конфига',
    diagnostics: 'Диагностика',
    columnDuration: 'Длительность',
    columnTask: 'Задача',
    columnTools: 'Тулы',
    columnAgents: 'Агенты',
    columnName: 'Имя',
    columnHour: 'Час',
    sectionProviders: 'Провайдеры',
    sectionModels: 'Модели',
    sectionProjects: 'Проекты',
    sectionByHour: 'По часам',
    untitled: 'без названия',
    totalTokens: '{{approx}}{{tokens}} токенов',
    tasks_one: '{{count}} задача',
    tasks_few: '{{count}} задачи',
    tasks_many: '{{count}} задач',
    usage: 'agentmeter <команда> [параметры]',
    usageCommands: 'команды: {{commands}}',
    usageFlags: 'общие флаги: --index <path> --config <path> --no-ingest --json',
    unknownCommand: 'неизвестная команда: {{command}}',
    verifyNotImplemented: 'команда verify не входит в этап 1.10 и пока не реализована',
    unsupported: 'команда {{command}} не поддерживается',
    dayAndSession: '--day и --session нельзя использовать вместе',
    noIngestIndex: '--no-ingest неприменим к команде index',
    needsValue: '{{flag}} требует значение',
    unknownFlag: 'неизвестный флаг: {{flag}}',
    twiceFlag: 'флаг {{flag}} указан дважды',
    badDate: 'неверная дата: {{value}}',
    positiveInt: '{{name}} должен быть положительным целым числом',
    badProvider: '--provider должен быть claude или codex',
    badBy: '--by должен быть tool, server, skill, agent или model',
  },
} as const
