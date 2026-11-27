/* ДТ-ИМПУТАЦИЯ · данные: реестр признаков, синтетическая популяция, клиент, сценарии */
(function (global) {
  'use strict';
  const U = global.DT.util;
  const D = {};

  /* =========================================================
     Слои профиля (как в исходной идее)
     ========================================================= */
  D.LAYERS = [
    { id: 'internal',   name: 'Внутренний',   source: 'История в компании',            note: 'новый клиент — истории нет' },
    { id: 'behavioral', name: 'Поведенческий', source: 'Приложение, телематика',       note: 'клиент не пользуется приложением' },
    { id: 'partner',    name: 'Партнёрский',  source: 'Банки, ритейл, телеком',          note: 'нет согласия / партнёр не отвечает' },
    { id: 'external',   name: 'Внешний',      source: 'Госуслуги, регистраторы, API',    note: 'API недоступен, лимит запросов' },
    { id: 'public',     name: 'Публичный',    source: 'Соцсети, открытые реестры',       note: 'данные устарели или неполные' }
  ];

  /* =========================================================
     Реестр признаков
     transform: 'log' — моделируем в лог-шкале (скошенные величины)
     ========================================================= */
  const F = [
    { id: 'age',          layer: 'internal',   label: 'Возраст водителя',        unit: 'лет',  short: 'Возраст',        transform: 'none', sens: false, role: 'core',   min: 18,  max: 80,  d: 0 },
    { id: 'vehicle_age',  layer: 'internal',   label: 'Возраст автомобиля',      unit: 'лет',  short: 'Возраст авто',   transform: 'none', sens: false, role: 'core',   min: 0,   max: 20,  d: 1 },
    { id: 'tenure',       layer: 'internal',   label: 'Стаж в компании',         unit: 'лет',  short: 'Стаж',           transform: 'none', sens: false, role: 'core',   min: 0,   max: 30,  d: 1 },
    { id: 'claims_3y',    layer: 'internal',   label: 'Обращений за 3 года',     unit: 'шт',   short: 'Обращения',      transform: 'none', sens: false, role: 'core',   min: 0,   max: 12,  d: 1 },
    { id: 'app_sessions', layer: 'behavioral', label: 'Сессии в приложении',     unit: '/мес', short: 'Приложение',     transform: 'log',  sens: false, role: 'middle', min: 0,   max: 80,  d: 1 },
    { id: 'mileage',      layer: 'behavioral', label: 'Пробег',                  unit: 'км/год', short: 'Пробег',       transform: 'log',  sens: false, role: 'core',   min: 500, max: 90000, d: 0 },
    { id: 'hard_braking', layer: 'behavioral', label: 'Резких торможений',       unit: '/100 км', short: 'Торможения', transform: 'log',  sens: false, role: 'middle', min: 0,   max: 40,  d: 1 },
    { id: 'night_share',  layer: 'behavioral', label: 'Доля ночных поездок',     unit: '%',    short: 'Ночные поездки', transform: 'none', sens: false, role: 'middle', min: 0,   max: 1,   d: 2, pct: true },
    { id: 'income',       layer: 'partner',    label: 'Доход',                    unit: 'тыс ₽/мес', short: 'Доход',   transform: 'log',  sens: true,  role: 'sens',   min: 15,  max: 900, d: 0 },
    { id: 'credit_score', layer: 'partner',    label: 'Скоринг партнёра',         unit: 'б.',   short: 'Скоринг',        transform: 'none', sens: false, role: 'middle', min: 300, max: 950, d: 0 },
    { id: 'family_status',layer: 'partner',    label: 'Семейное положение',       unit: '',     short: 'Семья',          transform: 'none', sens: false, role: 'weak',   min: 0,   max: 1,   d: 2 },
    { id: 'district_risk',layer: 'external',   label: 'Риск района',              unit: 'инд.', short: 'Район',          transform: 'none', sens: false, role: 'core',   min: 0,   max: 1,   d: 2 },
    { id: 'vehicle_condition', layer: 'external', label: 'Состояние авто (ТО)',   unit: 'б.',   short: 'Состояние',      transform: 'none', sens: false, role: 'middle', min: 0,   max: 100, d: 0 },
    { id: 'social_signal',layer: 'public',     label: 'Публичный сигнал',        unit: '',     short: 'Публичный',      transform: 'none', sens: false, role: 'weak',   min: 0,   max: 1,   d: 2 }
  ];
  D.FEATURES = F;
  D.F = {};
  F.forEach((f) => { D.F[f.id] = f; });
  D.FEATURE_IDS = F.map((f) => f.id);

  /* базовые средние популяции — заполняются в buildPopulation() */
  D.base = { logMileage: 9.15, logBraking: 0.95, logIncome: Math.log(105) };

  /* =========================================================
     Генератор синтетической популяции (псевдо-реальные зависимости)
     ========================================================= */
  const DISTRICTS = [
    { name: 'Центральный', risk: 0.34, inc: 1.35, w: 0.18 },
    { name: 'Северный',    risk: 0.26, inc: 1.22, w: 0.16 },
    { name: 'Заречный',    risk: 0.55, inc: 0.88, w: 0.22 },
    { name: 'Промзона',    risk: 0.72, inc: 0.74, w: 0.17 },
    { name: 'Южный',       risk: 0.44, inc: 1.02, w: 0.15 },
    { name: 'Пригород',    risk: 0.39, inc: 1.08, w: 0.12 }
  ];

  function poisson(rng, lambda) {
    if (lambda <= 0) return 0;
    if (lambda > 22) { // нормальное приближение
      return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * U.randn(rng)));
    }
    let L = Math.exp(-lambda), k = 0, p = 1;
    do { k++; p *= rng(); } while (p > L);
    return k - 1;
  }

  D.buildPopulation = function (seed, n, opts) {
    opts = opts || {};
    const rng = U.mulberry32(seed);
    const rows = [];
    for (let i = 0; i < n; i++) {
      // район
      let r = rng(), acc = 0, dist = DISTRICTS[0];
      for (const d of DISTRICTS) { acc += d.w; if (r <= acc) { dist = d; break; } }

      const age = U.clamp(43 + 12.5 * U.randn(rng), 20, 74);
      const vehicleAge = U.clamp(U.lognormal(rng, 0.85, 0.6), 0, 16);
      const income = U.clamp(U.lognormal(rng, Math.log(96 * dist.inc), 0.34), 22, 820);
      const apps = Math.round(U.clamp(U.lognormal(rng, Math.log(19) - 0.028 * (age - 43), 0.7), 0, 70));
      const night = U.clamp(0.27 + 0.085 * U.randn(rng) + 0.05 * (age < 30 ? 1 : 0), 0.02, 0.95);
      const mileage = U.clamp(
        U.lognormal(rng, Math.log(9500) + 0.075 * vehicleAge - 0.0035 * (age - 43) + 0.30 * Math.log(dist.inc), 0.42),
        1500, 68000
      );
      const braking = U.clamp(
        U.lognormal(rng, Math.log(2.9) - 0.012 * (age - 43) + 0.006 * night * 100, 0.55),
        0.15, 30
      );
      const risk = U.clamp(dist.risk + 0.06 * U.randn(rng), 0.05, 0.97);
      const claimRate = 3.0 * Math.pow(mileage / 12000, 0.55) * Math.pow(braking / 3, 0.18) * (0.55 + risk) * Math.exp(-0.022 * (age - 43));
      const claims = U.clamp(poisson(rng, claimRate), 0, 11);
      const credit = Math.round(U.clamp(735 - 210 * (risk - 0.4) + 70 * U.randn(rng), 330, 940));
      const tenure = U.clamp(Math.min(age - 20, U.lognormal(rng, 1.0, 0.75)), 0, 25);
      const cond = U.clamp(93 - 4.3 * vehicleAge - 6.5 * claims + 7 * U.randn(rng), 6, 100);
      const social = U.clamp(0.5 + 0.22 * U.randn(rng), 0.02, 0.98);
      const fam = rng() < U.sigmoid(-0.25 + 0.05 * (age - 42)) ? 1 : 0;

      rows.push({
        age, 'vehicle_age': vehicleAge, tenure, 'claims_3y': claims,
        app_sessions: apps, mileage, hard_braking: braking, night_share: night,
        income, credit_score: credit, family_status: fam,
        district_risk: risk, vehicle_condition: cond, social_signal: social,
        _district: dist.name, _holdout: !!opts.holdout
      });
    }
    return rows;
  };

  /* =========================================================
     Инициализация данных (вызывается один раз при старте)
     ========================================================= */
  D.N_TRAIN = 2400;
  D.N_HOLDOUT = 120;

  D.init = function () {
    D.pop = D.buildPopulation(20260311, D.N_TRAIN);
    D.holdout = D.buildPopulation(777001, D.N_HOLDOUT, { holdout: true });
    // популяционные моменты (нужны для стандартизации и шкалы уверенности)
    D.popStats = {};
    D.FEATURES.forEach((f) => {
      const col = D.pop.map((r) => r[f.id]);
      const logCol = f.transform === 'log' ? col.map((v) => Math.log(Math.max(v, 1e-6))) : col;
      const lo = f.transform === 'log' ? Math.log(f.min || 0.001) : f.min;
      D.popStats[f.id] = {
        mean: U.mean(logCol), sd: U.sd(logCol),
        rawMean: U.mean(col), rawSd: U.sd(col),
        lo: lo, hi: f.transform === 'log' ? Math.log(f.max) : f.max
      };
    });
    D.popStats.factory = D.popStats;
    D.defaultClient = D.makeClient(D.DEFAULT_SPEC);
    D.client = D.defaultClient;
    return D;
  };

  /* =========================================================
     Клиенты для демонстрации
     ========================================================= */
  D.CLIENT_SEQ = 24817;

  /* демо-клиент из документа: много ездит и именно поэтому скрывает пробег */
  D.DEFAULT_SPEC = {
    id: 'KL-24817',
    name: 'А. Волков',
    vehicle: 'Kia Sportage, 2022',
    district: 'Заречный',
    since: 'обращение от 14.05',
    truth: {
      age: 34,
      'vehicle_age': 3.2,
      tenure: 0,
      'claims_3y': 0,
      app_sessions: 23,
      mileage: 26400,
      hard_braking: 4.9,
      night_share: 0.31,
      income: 148,
      credit_score: 688,
      family_status: 0,
      district_risk: 0.58,
      vehicle_condition: 71,
      social_signal: 0.54
    },
    history: [
      { date: '14.05', field: 'mileage', event: 'отказ в доступе к телематике', via: 'приложение' },
      { date: '18.05', field: 'mileage', event: 'повторный отказ', via: 'приложение' },
      { date: '18.05', field: 'hard_braking', event: 'отказ в доступе к телематике', via: 'приложение' }
    ]
  };

  D.NAMES = ['А. Волков', 'М. Ковалёва', 'Д. Гареев', 'И. Соколова', 'П. Ким', 'С. Никитин',
    'О. Лебедева', 'Р. Ахметов', 'Е. Морозова', 'В. Панов', 'Н. Ильина', 'Т. Юсупов'];
  D.VEHICLES = ['Kia Rio, 2021', 'Toyota Camry, 2019', 'Lada Vesta, 2024', 'Hyundai Solaris, 2020',
    'Skoda Octavia, 2018', 'Kia Sportage, 2022', 'Renault Logan, 2017', 'VW Polo, 2023',
    'Chery Tiggo 7, 2024', 'Volvo XC60, 2021'];
  D.DISTRICTS_NAMES = ['Центральный', 'Северный', 'Заречный', 'Промзона', 'Южный', 'Пригород'];

  /* готовые персоны для показа — все 14 признаков заполнены согласованно */
  D.PRESETS = [
    {
      key: 'young', title: 'Молодой водитель', hint: '24 года · новый автомобиль',
      vehicle: 'Lada Vesta, 2025', district: 'Южный', history: [],
      truth: { age: 24, 'vehicle_age': 0.6, tenure: 0, 'claims_3y': 0, app_sessions: 38, mileage: 8200,
        hard_braking: 6.4, night_share: 0.42, income: 68, credit_score: 645, family_status: 0,
        district_risk: 0.63, vehicle_condition: 96, social_signal: 0.72 }
    },
    {
      key: 'courier', title: 'Курьер', hint: '29 лет · 40 тыс. км/год',
      vehicle: 'Renault Logan, 2019', district: 'Промзона',
      history: [{ date: '12.04', field: 'mileage', event: 'отказ в доступе к телематике', via: 'приложение' }],
      truth: { age: 29, 'vehicle_age': 5.5, tenure: 1, 'claims_3y': 1, app_sessions: 27, mileage: 39800,
        hard_braking: 8.1, night_share: 0.51, income: 74, credit_score: 612, family_status: 1,
        district_risk: 0.66, vehicle_condition: 71, social_signal: 0.44 }
    },
    {
      key: 'senior', title: 'Опытный, полный стаж', hint: '52 года · стаж 9 лет',
      vehicle: 'Toyota Camry, 2019', district: 'Северный', history: [],
      truth: { age: 52, 'vehicle_age': 5.4, tenure: 9, 'claims_3y': 0, app_sessions: 9, mileage: 14600,
        hard_braking: 2.7, night_share: 0.17, income: 215, credit_score: 815, family_status: 1,
        district_risk: 0.27, vehicle_condition: 66, social_signal: 0.31 }
    },
    {
      key: 'retiree', title: 'Пенсионер', hint: '68 лет · малый пробег',
      vehicle: 'Skoda Octavia, 2014', district: 'Пригород', history: [],
      truth: { age: 68, 'vehicle_age': 11, tenure: 4, 'claims_3y': 0, app_sessions: 3, mileage: 5800,
        hard_braking: 2.2, night_share: 0.07, income: 48, credit_score: 790, family_status: 1,
        district_risk: 0.31, vehicle_condition: 49, social_signal: 0.19 }
    },
    {
      key: 'newbie', title: 'Новый клиент без истории', hint: '36 лет · первое обращение',
      vehicle: 'Hyundai Solaris, 2024', district: 'Центральный', history: [],
      truth: { age: 36, 'vehicle_age': 0, tenure: 0, 'claims_3y': 0, app_sessions: 14, mileage: 11200,
        hard_braking: 3.8, night_share: 0.24, income: 112, credit_score: 705, family_status: 1,
        district_risk: 0.45, vehicle_condition: 92, social_signal: 0.5 }
    }
  ];

  D.ageWord = function (n) {
    const a = Math.round(n);
    const t = a % 100;
    if (t >= 11 && t <= 14) return 'лет';
    const d = a % 10;
    if (d === 1) return 'год';
    if (d >= 2 && d <= 4) return 'года';
    return 'лет';
  };

  D.makeId = function () {
    D.CLIENT_SEQ += 13 + Math.floor(Math.random() * 74);
    return 'KL-' + D.CLIENT_SEQ;
  };

  /* Единая фабрика клиента: правит значения в границы признаков,
     собирает подпись и историю отказов. spec.truth — любые поля из 14. */
  D.makeClient = function (spec) {
    spec = spec || {};
    const truth = {};
    D.FEATURE_IDS.forEach((id) => {
      const f = D.F[id];
      let v = spec.truth && spec.truth[id] !== undefined && spec.truth[id] !== ''
        ? Number(spec.truth[id]) : D.popStats[id].rawMean;
      if (!isFinite(v)) v = D.popStats[id].rawMean;
      truth[id] = Math.min(f.max, Math.max(f.min, v));
    });
    const vehicle = spec.vehicle || 'Авто клиента';
    const district = spec.district || '';
    return {
      id: spec.id || D.makeId(),
      name: spec.name || 'Новый клиент',
      vehicle: vehicle,
      district: district,
      profile: [Math.round(truth.age) + ' ' + D.ageWord(truth.age),
        vehicle, district].filter(Boolean).join(' · '),
      since: spec.since || 'обращение от ' + new Date().toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' }),
      truth: truth,
      history: Array.isArray(spec.history) ? spec.history.slice() : [],
      custom: !!spec.custom,
      spec: spec
    };
  };

  /* случайный клиент из той же популяции, на которой учится импутация */
  D.randomClient = function () {
    const row = D.buildPopulation((Math.random() * 1e9) | 0, 1)[0];
    const truth = {};
    D.FEATURE_IDS.forEach((id) => { truth[id] = row[id]; });
    return {
      id: D.makeId(),
      name: U.pick(Math.random, D.NAMES),
      vehicle: U.pick(Math.random, D.VEHICLES),
      district: row._district || '',
      since: 'обращение от ' + new Date().toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' }),
      truth: truth,
      history: [],
      custom: true
    };
  };

  /* быстрые проверки осмысленности ручного ввода */
  D.validateClient = function (spec) {
    const warnings = [];
    const t = spec.truth || {};
    const num = (k) => Number(t[k]);
    if (num('age') < 18 || num('age') > 80) warnings.push('возраст вне 18–80');
    if (num('vehicle_age') > Math.max(0, num('age') - 18)) warnings.push('автомобиль старше, чем позволяет возраст водителя');
    if (num('tenure') > Math.max(0, num('age') - 18)) warnings.push('стаж в компании больше водительского стажа');
    if (num('mileage') > 60000) warnings.push('пробег выше 60 тыс. км/год — это край популяции, интервал будет широким');
    if (num('mileage') < 2000) warnings.push('пробег ниже 2 тыс. км/год — редкий сегмент');
    if (num('claims_3y') > 5) warnings.push('больше 5 обращений за 3 года — сегмент с плохой историей');
    if (num('night_share') > 0.85) warnings.push('доля ночных поездок выше 85 %');
    if (num('vehicle_condition') < 20) warnings.push('состояние авто ниже 20 баллов');
    return warnings;
  };

  /* =========================================================
     Сценарии доступности данных
     ========================================================= */
  const T = { MAR: 'MAR', MCAR: 'MCAR', MNAR: 'MNAR' };
  D.TYPES = T;

  D.SCENARIOS = [
    {
      id: 'full',
      title: 'Полный профиль',
      hint: 'Все слои ответили, клиент дал согласие',
      tone: 'good',
      note: 'Базовый случай: Digital Twin получает почти точку. Сравните силуэт решения с остальными сценариями.',
      states: {
        social_signal: { status: 'stale', months: 7, reason: 'публичные данные обновлялись 7 мес. назад' }
      }
    },
    {
      id: 'partners',
      title: 'Партнёры молчат',
      hint: 'Банк и телеком не ответили',
      tone: 'warn',
      note: 'Пропуски MAR: зависят от наблюдаемых данных. Импутация допустима, но уверенность ниже.',
      states: {
        credit_score: { status: 'missing', type: 'MAR', reason: 'банк-партнёр не ответил за 48 ч' },
        family_status: { status: 'missing', type: 'MAR', reason: 'телеком не ответил' },
        income: { status: 'blocked', reason: 'чувствительный признак — импутация запрещена' },
        social_signal: { status: 'stale', months: 7, reason: 'публичные данные обновлялись 7 мес. назад' }
      }
    },
    {
      id: 'api',
      title: 'Внешние API упали',
      hint: 'Госуслуги и регистраторы недоступны',
      tone: 'warn',
      note: 'Пропуски MCAR: случайные, не связаны со значением. Импутация надёжнее всего, но API тянет за собой сразу два признака.',
      states: {
        district_risk: { status: 'missing', type: 'MCAR', reason: 'внешний API: таймаут 504' },
        vehicle_condition: { status: 'missing', type: 'MCAR', reason: 'регистратор не отвечает' },
        social_signal: { status: 'stale', months: 7, reason: 'публичные данные обновлялись 7 мес. назад' }
      }
    },
    {
      id: 'consent',
      title: 'Нет согласия на телематику',
      hint: 'Клиент не пустил к данным о поездках',
      tone: 'danger',
      note: 'Пропуски MNAR: скрывают именно те, у кого значение повышенное. Импутация занижает риск — нужен сдвиг приора и подробный интервал.',
      states: {
        mileage: { status: 'missing', type: 'MNAR', reason: 'нет согласия на телематику' },
        hard_braking: { status: 'missing', type: 'MNAR', reason: 'нет согласия на телематику' },
        night_share: { status: 'missing', type: 'MAR', reason: 'приложение не подключено' },
        social_signal: { status: 'stale', months: 7, reason: 'публичные данные обновлялись 7 мес. назад' }
      }
    },
    {
      id: 'adversarial',
      title: 'Adversarial-пропуски',
      hint: 'Клиент системно скрывает одни и те же поля',
      tone: 'danger',
      note: 'Пропуски MNAR + повторяемость: детектор фиксирует систематический отказ, система усиливает приор и всё равно не рискует.',
      states: {
        mileage: { status: 'missing', type: 'MNAR', reason: 'третий отказ подряд' },
        hard_braking: { status: 'missing', type: 'MNAR', reason: 'второй отказ подряд' },
        app_sessions: { status: 'missing', type: 'MAR', reason: 'приложение удалено после отказа' },
        credit_score: { status: 'missing', type: 'MAR', reason: 'банк-партнёр не ответил' },
        family_status: { status: 'missing', type: 'MAR', reason: 'телеком не ответил' },
        district_risk: { status: 'missing', type: 'MCAR', reason: 'внешний API: таймаут 504' },
        income: { status: 'blocked', reason: 'чувствительный признак — импутация запрещена' },
        social_signal: { status: 'stale', months: 7, reason: 'публичные данные обновлялись 7 мес. назад' }
      }
    }
  ];

  /* продуктовая линейка для симуляции договоров */
  D.VARIANTS = [
    { id: 'econom', name: 'Эконом', premium: 0, franchise: 25000, installments: 0,
      cover: 'ущерб', scope: { glass: false, theft: false, dsago: false },
      desc: 'франшиза 25 000 ₽ · оплата разово' },
    { id: 'standart', name: 'Стандарт', premium: 0, franchise: 10000, installments: 4,
      cover: 'ущерб + стекло', scope: { glass: true, theft: false, dsago: false },
      desc: 'франшиза 10 000 ₽ · 4 платежа' },
    { id: 'premium', name: 'Премиум', premium: 0, franchise: 0, installments: 12,
      cover: 'полное покрытие + ДСАГО', scope: { glass: true, theft: true, dsago: true },
      desc: 'без франшизы · 12 платежей' }
  ];

  D.CONF_THRESHOLDS = { offer: 0.86, guarded: 0.62, coreFloor: 0.45 };

  global.DT.data = D;
})(typeof window !== 'undefined' ? window : globalThis);