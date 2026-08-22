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
    // «Claude, 5-часовое окно» — строка 1297 макета. Провайдер стоит в самом
    // имени окна там, где над списком нет табов: в паузе (2.8) окна обоих
    // провайдеров лежат вперемешку, и назвать их больше нечем.
    ofProvider: '{{provider}}, {{window}}',
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
    limitsAsked: 'Anthropic · {{ago}}',
    limitsNever: 'Anthropic · не спрашивали',
    limitsWaiting: 'Anthropic · ждём {{in}}',
    limitsAsk: 'Спросить лимиты у Anthropic',
    updatedAgo: 'обновлено {{ago}}',
    // Кнопка в шапке (7.2). Знак ⌘ написан прямо в подписи, как у «Открыть
    // окно ⌘⏎»: клавиша одна и та же, а рисовать её по платформе значило бы
    // держать два каталога вместо одного.
    refresh: 'Обновить · ⌘R',
    refreshFailed: 'Не удалось обновить',
    refreshStale: 'Числа на экране — от прошлого снимка.',
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
    // Живая строка ленты (6.1). «Сейчас» — про ход, который идёт: у ждущего
    // агента ход у человека, и там вместо этой фразы стоит его состояние.
    liveNow: 'сейчас: «{{prompt}}»',
    turnSpend: '+{{tokens}} за ход',
    livePinned: 'сначала активные',
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
   * «Куда ушло сегодня» — постоянное против разового (4.1, строки 806–817).
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
    // Строки сходимости правой колонки (макет, 1141–1150): остаток разового
    // сверх вызовов и итог, равный подписи оси.
    marginalRest: 'Ответы модели, ваш ввод и чтение контекста',
    marginalRestRequests_one: '{{count}} запрос',
    marginalRestRequests_few: '{{count}} запроса',
    marginalRestRequests_many: '{{count}} запросов',
    marginalTotalDay: 'Разовый расход за день',
    marginalTotalSession: 'Разовый расход за сессию',
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
    // Три пустоты и загрузка — разные слова, как у ленты: «индекс не собран»,
    // «за период не работали» и «фильтр отсёк всё» различимы только текстом.
    emptyFilter: 'По выбранному фильтру запросов нет',
    loading: 'Загружаем развёртку…',
    // Унаследованный фильтр ленты. Имена провайдеров — имена продуктов, в
    // `{{value}}` они приходят как есть.
    filterNote: 'фильтр ленты: {{value}}',
    // День, открытый с «Истории». Чип обязан называть дату: молча показанный
    // чужой день читается как сегодняшний — рядом с ним даты больше нет.
    dayNote: 'день из истории: {{date}}',
    dayReset: 'Вернуться к сегодняшнему дню',
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
    // Подсказка по наведению на статью (4.9). Цены штуки в ней нет намеренно:
    // внутри блока доля строки была бы долей от доли.
    detailTitle: 'Что внутри',
    detailIn: 'в {{count}} из {{total}}',
    detailMore_one: 'и ещё {{count}}',
    detailMore_few: 'и ещё {{count}}',
    detailMore_many: 'и ещё {{count}}',
    detailResidual:
      'Измеренный остаток: системный промпт и схемы вшитых инструментов. Из чего он состоит, в логе не написано.',
    detailSystem: 'Базовые инструкции агента одним блоком. Перечислимых штук в них нет.',
    detailUserTurn: 'Ваша собственная первая реплика. Тексты промптов экран не показывает.',
    detailUnnamed_one: 'в {{count}} сессии источник состава не назвал',
    detailUnnamed_few: 'в {{count}} сессиях источник состава не назвал',
    detailUnnamed_many: 'в {{count}} сессиях источник состава не назвал',
    detailNone: 'Состава в логе нет',
  },

  /**
   * Переплата за паузу — раздел 10 макета (4.4).
   *
   * Подзаголовок говорит про час, а не про пять минут, потому что час — это
   * измерение: 96.5% записанных токенов уехало в `ephemeral_1h`. Срок
   * подставляется, а не зашит: у сабагентов он пятиминутный.
   */
  /**
   * Вкладка «История» — разделы 8 и 8б макета (4.6).
   *
   * «С данными» и «данных нет» — разные слова про разные вещи, и это главное,
   * что здесь есть: день с нулём измерен, день без данных не наблюдался.
   */
  /**
   * Уведомления — раздел 9 макета (4.7).
   *
   * Знак `≈` подставляется в `{{percent}}` вместе с числом, а не пишется в
   * шаблоне: у Codex процент точный, у Claude до калибровки 1.9 — оценка, и
   * зашитый знак соврал бы про один из двух.
   */
  /** Меню трея (4.8). */
  menu: {
    export: 'Выгрузить расход…',
    quit: 'Выйти',
  },

  notify: {
    limitTitle: '{{provider}} — {{percent}} {{window}}',
    limitBody: 'Сброс в {{reset}}. Сейчас работают: {{agents}}.',
    sessionTitle: 'Сессия дороже {{limit}}',
    sessionBody: '{{project}} — {{tokens}} в промпте.',
    doneTitle: '{{provider}} закончил — {{project}}',
    waitingTitle: '{{provider}} ждёт ответа — {{project}}',
    agentBody: '{{branch}} · {{tokens}}',
    noBranch: 'без ветки',
  },

  history: {
    span7: 'неделя',
    span30: '30 дней',
    spanAll: 'всё',
    tokensWord: 'токенов',
    since: 'данные с {{date}} · {{days}}',
    daysWithSpend_one: '{{count}} день с расходом',
    daysWithSpend_few: '{{count}} дня с расходом',
    daysWithSpend_many: '{{count}} дней с расходом',
    covered_one: '{{count}} день с данными',
    covered_few: '{{count}} дня с данными',
    covered_many: '{{count}} дней с данными',
    missing: '{{date}} данных нет',
    heatmap: 'День × час',
    heatmapHint: 'цвет — агент, насыщенность — объём',
    // Ноль — измерение, тире — незнание. Разные знаки, потому что разные вещи.
    zero: '0',
    noData: '—',
    tokenTypes: 'Типы токенов',
    providers: 'Провайдеры',
    splitTitle: 'Постоянный и разовый',
    splitMedian: 'медиана за {{days}} — {{percent}}%',
    projects: 'Проекты',
    openBreakdown: 'Развёртка за этот день',
    total: 'итого',
    counts: '{{sessions}} · {{tasks}} · {{requests}}',
    emptyIndex: 'Первичное индексирование — история появится после чтения логов',
    emptyRange: 'За этот период данных нет',
    foldedProjects_one: '+ {{count}} проект',
    foldedProjects_few: '+ {{count}} проекта',
    foldedProjects_many: '+ {{count}} проектов',
  },

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
    // паузу — свойство дня, а не задачи (макет, строки 1788–1791).
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
    vanishedLog: 'логи Claude за эти сутки удалены им самим — расход не меньше показанного',
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
    planDropped:
      'потолки, заданные планом «{{plan}}», сброшены: теперь они измеряются калибровкой, а не выбираются',
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
    // Что показывать в попапе (7.5). На месте прежних «потолков плана»: их
    // выбирать было нечем — потолок измеряется, а не заявляется (7.4), — а
    // выбрать, какие окна нужны перед глазами, может только человек.
    popupLimits: 'Что показывать в попапе',
    popupLimitsNote:
      'снятое окно исчезает и из попапа, и из цвета значка, и из уведомлений — приложение о нём больше не напоминает',
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
    launchAtLogin: 'Запускать при входе в систему',
    version: 'Версия',
    updateAuto: 'Проверять обновления',
    updateAutoNote: '— единственный сетевой вызов приложения',
    updateCheck: 'Проверить',
    updateInstall: 'Установить и перезапустить',
    updateUnsupported: 'обновления работают только в установленном приложении',
    updateOff: 'проверка выключена',
    updateIdle: 'установлена последняя версия',
    updateChecking: 'проверяем…',
    updateDownloading: 'скачиваем {{version}} — {{percent}}%',
    updateReady: '{{version}} скачана, поставится при перезапуске',
    updateError: 'не удалось проверить: {{message}}',
    launchUnpackaged: 'доступно только в установленном приложении',
    tabApp: 'Приложение',

    // Откуда берутся проценты лимита (6.3, 6.4). Хук строки состояния стоял
    // тут до 7.5 и снят вместе с потолками: строку рисует только терминальный
    // CLI, и в VS Code он молчал месяцами.
    usage: 'Проценты лимита от провайдера',

    // Второй источник тех же процентов (6.3): запрос к Anthropic. Слово «сеть»
    // стоит в первой же строке намеренно — это единственное место продукта,
    // откуда наружу уходят креденшелы, и узнать об этом человек должен до
    // того, как щёлкнет тумблером, а не из README.
    oauthOn: 'Спрашивать',
    oauthOff: 'Не спрашивать',
    oauthNote:
      '— запрос к Anthropic токеном Claude Code, раз в четверть часа. Работает там, где строки состояния нет вовсе, — например в VS Code. Это второй и последний сетевой вызов приложения',
    oauthCredsFile: 'токен взят из .credentials.json',
    oauthCredsKeychain: 'токен взят из связки ключей',
    oauthCredsMissing: 'токен Claude Code не найден — авторизуйтесь в самом Claude Code',
    oauthNever: 'ещё не спрашивали',
    oauthFetched: 'спрошено {{ago}}: 5 ч — {{fiveHour}}%, 7 дней — {{weekly}}%',
    oauthFetchedFew: 'спрошено {{ago}}, окон в ответе нет',
    oauthRefresh: 'Спросить сейчас',
    oauthRetry: 'Anthropic просит подождать — следующая попытка {{at}}',

    // То же для Codex (6.4). Подпись говорит про свежесть, а не про сам
    // процент: процент у Codex есть и в логах, а вот возраст его — вчерашний,
    // и это единственное, что тумблер меняет.
    codexApiOn: 'Спрашивать',
    codexApiOff: 'Не спрашивать',
    codexApiNote:
      '— запрос к OpenAI токеном Codex, раз в четверть часа. В логах процент точный, но написан он в момент последнего запроса: после дня без Codex он про позавчерашнее окно',
    codexApiCredsFile: 'токен взят из ~/.codex/auth.json',
    codexApiCredsExpired: 'токен Codex просрочен — запустите codex, он обновит его сам',
    codexApiCredsMissing: 'токен Codex не найден — авторизуйтесь в самом Codex',
    codexApiNever: 'ещё не спрашивали',
    codexApiFetched: 'спрошено {{ago}}: {{windows}}',
    codexApiFetchedFew: 'спрошено {{ago}}, окон в ответе нет',
    codexApiRetry: 'OpenAI просит подождать — следующая попытка {{at}}',
  },

  /**
   * Отказы второго источника (6.3).
   *
   * Все до одного — **наш пересказ**, а не то, что прислал сервер: тело ответа
   * человеку не показывается никогда, в него попадает и эхо запроса.
   */
  oauth: {
    noCredentials: 'токен Claude Code не найден',
    offline: 'не дозвонились до Anthropic — показан прежний ответ',
    needsLogin: 'Anthropic не принял токен: авторизуйтесь в Claude Code заново',
    throttled: 'Anthropic просит спрашивать реже',
    httpError: 'Anthropic ответил {{status}}',
    badBody: 'ответ Anthropic не разбирается',
  },

  /** Отказы второго источника Codex (6.4). То же правило: наш пересказ. */
  codexOauth: {
    noCredentials: 'токен Codex не найден',
    expired: 'токен Codex просрочен — запустите codex, он обновит его сам',
    offline: 'не дозвонились до OpenAI — показан прежний ответ',
    needsLogin: 'OpenAI не принял токен: авторизуйтесь в Codex заново',
    throttled: 'OpenAI просит спрашивать реже',
    httpError: 'OpenAI ответил {{status}}',
    badBody: 'ответ OpenAI не разбирается',
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
    vanishedSources: 'Логов, которых уже нет на диске: {{sources}} — расход по ним есть только здесь',
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
    badGrain: 'неизвестная единица выгрузки: {{value}} (нужно task или day)',
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
