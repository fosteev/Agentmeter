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
    byTicket: 'По тикетам',
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
    tickets_one: '+ {{count}} тикет',
    tickets_few: '+ {{count}} тикета',
    tickets_many: '+ {{count}} тикетов',
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

  /**
   * «Куда ушло сегодня» — постоянное против разового (4.1, строки 767–778).
   *
   * Три вывода вместо одного не для красоты: подпись — это суждение о доле, и
   * растянуть «почти половина» на диапазон от четверти до половины значило бы
   * соврать на нижнем крае. Каждая фраза верна во всей своей полосе.
   */
  split: {
    title: 'Куда ушло сегодня',
    recurring: 'постоянный',
    marginal: 'разовый',
    value: '{{tokens}} · {{percent}}%',
    noteHigh: 'Больше половины дня ушло на то, что перезагружалось в каждую сессию.',
    noteMedium: 'Четверть дня и больше ушла на то, что перезагружалось в каждую сессию.',
    noteLow: 'Основной расход дня — сама работа, а не то, что грузится при старте.',
    link: 'Развёртка →',
  },

  /**
   * Вкладка «Развёртка» — раздел 5 макета (4.2).
   *
   * У `system` два имени, и это не дубль: у Claude это неизмеримый остаток —
   * системный промпт со схемами вшитых тулов, — а у Codex он лежит в логе
   * дословно. Назвать их одинаково значило бы сказать, что мы измерили то,
   * чего не измеряли.
   */
  breakdown: {
    title: 'Стоимость одной сессии и во что она превратилась за день',
    lead: 'Слева — что уже лежит в промпте до вашего первого слова: платится целиком в каждой сессии. Справа — что агент реально вызывал: платится по факту.',
    scopeDay: 'за день',
    scopeSession: 'за сессию',
    left: 'Лежит в начале каждого промпта',
    right: 'Приносится в контекст по вызову',
    columnCategory: 'Категория',
    columnPerSession: 'За сессию',
    columnUsed: 'Исп-но',
    columnPeriod: 'За день',
    columnTool: 'Инструмент',
    columnCalls: 'Вызовов',
    columnAverage: 'Ср.',
    columnTotal: 'Всего',
    beforeFirstWord: 'Итого до первого слова',
    reread: 'Из них перечитывание',
    rereadHint: 'префикс перечитан {{count}} раз сверх первой записи',
    rereadTimes: '×{{count}}',
    totalCalls: 'Итого вызовов',
    usedOf: '{{used}} из {{loaded}}',
    unmeasurable: '—',
    footer: 'Правая колонка растёт от того, что вы делали. Левая растёт от того, что у вас включено, — и её видно только здесь.',
    systemResidual: 'Стартовый оверхед',
    systemPrompt: 'Системный промпт',
    toolSchemas: 'Схемы инструментов',
    mcpTools: 'MCP-серверы',
    mcpInstructions: 'Инструкции MCP',
    skills: 'Скиллы',
    agents: 'Сабагенты',
    memory: 'Файлы памяти',
    deferredTools: 'Отложенные инструменты',
    userTurn: 'Первая реплика',
    other: 'Прочее',
    // Строка 1070 макета. «Скриншоты» рядом с «картинками» не тавтология: у
    // Codex инструмент так и называется — `view_image`, а человек делает
    // именно скриншоты, и слово из его словаря стоит рядом со словом из лога.
    images: 'Картинки и скриншоты',
    adviceHeadline: '{{source}} · {{tools}} · {{calls}}',
    adviceTools_one: '{{count}} инструмент',
    adviceTools_few: '{{count}} инструмента',
    adviceTools_many: '{{count}} инструментов',
    adviceCalls_one: '{{count}} вызов',
    adviceCalls_few: '{{count}} вызова',
    adviceCalls_many: '{{count}} вызовов',
    adviceText_one:
      'Сервер не использовался ни разу за {{count}} сессию, но его описания грузились в каждую. Отключение вернёт {{tokens}}.',
    adviceText_few:
      'Сервер не использовался ни разу за {{count}} сессии, но его описания грузились в каждую. Отключение вернёт {{tokens}}.',
    adviceText_many:
      'Сервер не использовался ни разу за {{count}} сессий, но его описания грузились в каждую. Отключение вернёт {{tokens}}.',
    adviceEager_one:
      ' В {{count}} сессии набор был жадным — там он стоил больше, и насколько, из логов не видно.',
    adviceEager_few:
      ' В {{count}} сессиях набор был жадным — там он стоил больше, и насколько, из логов не видно.',
    adviceEager_many:
      ' В {{count}} сессиях набор был жадным — там он стоил больше, и насколько, из логов не видно.',
    adviceHidden_one: 'и ещё {{count}} такой сервер',
    adviceHidden_few: 'и ещё {{count}} таких сервера',
    adviceHidden_many: 'и ещё {{count}} таких серверов',
    emptyIndex: 'Первичное индексирование — развёртка появится после чтения логов',
    emptyScope: 'За этот период запросов не было',
    sessions_one: '{{count}} сессия',
    sessions_few: '{{count}} сессии',
    sessions_many: '{{count}} сессий',
    recurringAxis_one: 'Постоянный · ×{{count}} сессия',
    recurringAxis_few: 'Постоянный · ×{{count}} сессии',
    recurringAxis_many: 'Постоянный · ×{{count}} сессий',
    marginalAxis: 'Разовый · по вызовам',
    perSessionTotal: '{{tokens}} за сессию',
    calls_one: '{{count}} вызов',
    calls_few: '{{count}} вызова',
    calls_many: '{{count}} вызовов',
  },

  /**
   * Переплата за паузу — раздел 10 макета (4.4).
   *
   * Подзаголовок говорит про час, а не про пять минут, потому что час — это
   * измерение: 96.5% записанных токенов уехало в `ephemeral_1h`. Срок
   * подставляется, а не зашит: у сабагентов он пятиминутный.
   */
  rebuild: {
    title: 'Переплата за паузу',
    subtitle:
      'Кэш промпта живёт {{ttl}}. Пауза дольше — и прежний промпт едет заново записью вместо дешёвого чтения.',
    // Главное предложение блока: измеренное — слева от тире, неизмеренное —
    // справа. Придумывать «вы потеряли N токенов» нельзя: вес чтения кэша в
    // лимите подписки у Claude не откалиброван (1.9).
    caveat:
      'Токенов в сутках от этого не прибавилось — те же самые уехали записью, а не чтением. Дороже ли это и во сколько раз, зависит от прайса и в логах не написано.',
    share: '{{percent}}% расхода за период',
    tableTitle: 'Пересборки кэша за период',
    columnTimes: 'Раз',
    columnTokens: 'Токены',
    start: 'при старте сессии — неизбежно',
    pause: 'после паузы дольше {{ttl}}',
    early: 'кэш пропал раньше срока — причина в логе не названа',
    compact: 'контекст сжали',
    total: 'Всего пересборок',
    pauseTitle: 'Длина паузы',
    bucketRange: '{{from}} — {{to}}',
    bucketOver: 'больше {{from}}',
    bucketTotal: 'Итого',
    worst_one: 'Самая дорогая пауза — {{duration}}',
    worst_few: 'Самая дорогая пауза — {{duration}}',
    worst_many: 'Самая дорогая пауза — {{duration}}',
    worstWhere: '{{from}} → {{to}} · {{project}}',
    worstWhereBranch: '{{from}} → {{to}} · {{project}} · {{branch}}',
    // Строка в карточке задачи. Гистограммы там нет намеренно: переплата за
    // паузу — свойство дня, а не задачи (макет, строки 1749–1752).
    card_one: 'Пересборка кэша — {{count}} раз, {{tokens}}',
    card_few: 'Пересборка кэша — {{count}} раза, {{tokens}}',
    card_many: 'Пересборка кэша — {{count}} раз, {{tokens}}',
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
    // Пересборка кэша — не то же самое, что сжатие контекста, хотя в usage след
    // у них один (4.4). Столбик проваливается у первого и стоит на месте у
    // второй, и написать «сжатие» над непроваленным столбиком значит объяснить
    // человеку то, чего он не видит.
    rebuild: 'пересборка кэша',
    images_one:
      '{{count}} картинка в результате — {{tokens}} в промпт, и по размеру результата этого не видно',
    images_few:
      '{{count}} картинки в результате — {{tokens}} в промпт, и по размеру результата этого не видно',
    images_many:
      '{{count}} картинок в результате — {{tokens}} в промпт, и по размеру результата этого не видно',
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
      '{{count}} вызов с картинкой — по {{per}} на вызов, и в байтах результата этого не видно',
    toolImages_few:
      '{{count}} вызова с картинками — по {{per}} на вызов, и в байтах результата этого не видно',
    toolImages_many:
      '{{count}} вызовов с картинками — по {{per}} на вызов, и в байтах результата этого не видно',
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

  /**
   * Замечания загрузчика конфига (3.6). Их читает человек на экране настроек,
   * поэтому они текст, а не диагностика: путь поля остаётся как есть — это имя
   * ключа в файле, — а всё вокруг переводится.
   */
  config: {
    root: '<корень>',
    badJson: '{{path}}: не разбирается как JSON ({{message}}), взяты значения по умолчанию',
    expectedObject: '{{path}}: ожидался объект, взято значение по умолчанию',
    badType: '{{path}}: ожидалось {{expected}}, пришло {{got}} — взят дефолт',
    badValue: '{{path}}: допустимо {{expected}}, пришло {{got}} — взят дефолт',
    warnAboveDanger:
      'alerts: предупреждение на {{warn}}% стоит выше тревоги на {{danger}}% — оба порога взяты по умолчанию',
    typeList: 'список',
    typeNumber: 'число',
    typeString: 'строка',
    typeBoolean: 'да/нет',
  },

  /** Экран настроек — раздел 6 макета. */
  settings: {
    tabSources: 'Источники данных',
    tabLimits: 'Лимиты',
    tabAlerts: 'Уведомления',
    tabAppearance: 'Внешний вид',
    tabPrivacy: 'Приватность',
    logPaths: 'Пути к логам',
    sourceOk: '✓ {{files}} · {{size}}',
    sourceMissing: 'каталог не найден',
    files_one: '{{count}} файл',
    files_few: '{{count}} файла',
    files_many: '{{count}} файлов',
    megabytes: '{{value}} МБ',
    caps: 'Потолки лимитов по плану',
    claudePlan: 'Claude — план',
    codexPlan: 'Codex — план',
    capsEstimate: 'оценка по локальным логам',
    capsExact: 'точные значения приходят от сервера',
    planNotSet: 'не задан',
    thresholds: 'Пороги уведомлений',
    warnAt: 'Предупредить при',
    dangerAt: 'Тревога при',
    notifyOnIdle: 'Сообщать, когда агент закончил или ждёт ответа',
    theme: 'Тема',
    themeDark: 'тёмная',
    themeLight: 'светлая',
    themeSystem: 'системная',
    language: 'Язык',
    languageSystem: 'системный',
    dayStart: 'День начинается в',
    hour: '{{hour}}:00',
    hidePrompts: 'Скрыть тексты промптов',
    hidePromptsNote: '— в ленте останутся только названия задач',
    hidePaths: 'Скрыть пути к файлам',
    hidePathsNote: '— карточка задачи покажет только число затронутых файлов',
    problems: 'Замечания к файлу настроек',
    autostartLater: 'Запуск при входе в систему появится в 5.3 — тумблера, который ничего не делает, здесь нет',
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
    columnShare: 'Доля',
    residual: 'остаток',
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
