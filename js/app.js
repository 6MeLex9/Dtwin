/* ДТ-ИМПУТАЦИЯ · контроллер интерфейса */
(function () {
  'use strict';
  const U = DT.util, D = DT.data, I = DT.impute, TW = DT.twin, CH = DT.charts;
  const $ = (id) => document.getElementById(id);

  const state = {
    scenarioId: 'full',
    states: {},
    imp: null, sim: null, voi: [], explain: null, fb: null, recal: null,
    revealed: false, retrained: false,
    step: 0,
    activeTab: 'profile',
    controls: {
      sensitive: true, gate: true, ensemble: true,
      logging: true, fairness: true, contours: true
    },
    mnarShift: {},
    audit: []
  };

  /* ============================ утилиты ============================ */
  function fmtVal(id, v) {
    const f = D.F[id];
    if (v === null || v === undefined || !isFinite(v)) return '—';
    if (f.pct) return U.fmtPct(v, 0);
    return U.fmtNum(v, f.d) + (f.unit ? ' ' + f.unit : '');
  }
  function fmtShort(v) {
    if (!isFinite(v)) return '—';
    if (Math.abs(v) >= 1e6) return U.fmtDec(v / 1e6, 2) + ' млн';
    if (Math.abs(v) >= 1e4) return U.fmtNum(v / 1e3, 1) + ' тыс';
    return U.fmtNum(v, 0);
  }
  const STATUS_LABEL = { observed: 'получено', missing: 'отсутствует', stale: 'устарело', blocked: 'запрещено' };
  function statusChip(f) {
    const cls = f.status === 'observed' ? 'ok' : f.status === 'missing' ? 'warn' : f.status === 'blocked' ? 'bad' : 'info';
    return '<span class="chip ' + cls + '"><i class="sw"></i>' + (STATUS_LABEL[f.status] || f.status) + '</span>';
  }
  function typeChip(t) {
    if (!t || t === 'STALE') return '';
    const cls = t === 'MCAR' ? 'ok' : t === 'MAR' ? 'warn' : 'bad';
    return '<span class="chip ' + cls + ' mono">' + t + '</span>';
  }
  function toast(msg, kind) {
    const el = $('toast');
    el.textContent = msg;
    el.className = 'toast on ' + (kind || '');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { el.className = 'toast'; }, 3600);
  }
  function log(kind, msg) {
    if (!state.controls.logging) return;
    const d = new Date();
    const t = ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2) + ':' + ('0' + d.getSeconds()).slice(-2);
    state.audit.unshift({ t, kind, msg });
    if (state.audit.length > 60) state.audit.pop();
  }

  /* ============================ сценарии ============================ */
  function scenario() { return D.SCENARIOS.filter((s) => s.id === state.scenarioId)[0]; }

  function setScenario(id, silent) {
    state.scenarioId = id;
    const sc = scenario();
    state.states = JSON.parse(JSON.stringify(sc.states));
    state.revealed = false;
    state.retrained = false;
    state.recal = null;
    if (!silent) log('сценарий', 'доступность данных → «' + sc.title + '»');
    recompute();
  }

  function cycleFeature(id) {
    const f = D.F[id];
    const cur = state.states[id] || { status: 'observed' };
    let next;
    if (f.sens) {
      next = cur.status === 'observed' ? { status: 'blocked', reason: 'чувствительный признак — только ручной запрос' }
        : { status: 'observed' };
    } else if (cur.status === 'observed') {
      next = { status: 'missing', type: 'MCAR', reason: 'источник недоступен (ручной сценарий)' };
    } else if (cur.status === 'stale') {
      next = { status: 'missing', type: 'MCAR', reason: 'источник недоступен (ручной сценарий)' };
    } else if (cur.status === 'blocked') {
      next = { status: 'observed' };
    } else if (cur.status === 'missing') {
      if (cur.type === 'MCAR') next = { status: 'missing', type: 'MAR', reason: 'пропуск зависит от наблюдаемых данных' };
      else if (cur.type === 'MAR') next = { status: 'missing', type: 'MNAR', reason: 'пропуск зависит от скрытого значения' };
      else next = { status: 'observed' };
    }
    if (next.status === 'observed') delete state.states[id];
    else state.states[id] = next;
    log('ручной режим', D.F[id].label + ' → ' + (STATUS_LABEL[next.status] || next.status) + (next.type ? ' / ' + next.type : ''));
    recompute();
  }

  /* ============================ пересчёт ============================ */
  function recompute() {
    const t0 = performance.now();
    state.imp = I.run(state.states, { mnarShift: state.mnarShift, allowSensitive: !state.controls.sensitive });
    state.sim = TW.simulate(state.imp, { N: 1400, single: !state.controls.ensemble, gate: state.controls.gate });
    state.voi = TW.valueOfInfo(state.imp, state.sim, { N: 300 });
    state.explain = TW.explain(state.imp, state.sim);
    if (state.revealed) state.fb = feedback();
    recompute.ms = Math.round(performance.now() - t0);
    state.recomputeMs = recompute.ms;
    renderAll();
  }

  /* ============================ обратная связь ============================ */
  function feedback() {
    const rows = state.imp.missingFields.concat(state.imp.staleFields).map((f) => {
      const act = D.client.truth[f.id];
      const m = f.imputed;
      return {
        id: f.id, label: f.label, unit: f.unit, d: f.d, pct: f.pct,
        est: m.mean, lo: m.lo, hi: m.hi, actual: act,
        err: (m.mean - act) / Math.max(Math.abs(act), 1e-6),
        inCI: act >= m.lo && act <= m.hi,
        conf: f.conf, type: f.type || 'STALE'
      };
    });
    const mae = rows.length ? U.mean(rows.map((r) => Math.abs(r.err))) : 0;
    const bias = rows.length ? U.mean(rows.map((r) => r.err)) : 0;
    const cover = rows.length ? rows.filter((r) => r.inCI).length / rows.length : 1;
    const cf = TW.priceIfTruth(state.sim);
    return { rows, mae, bias, cover, cf, priceNow: state.sim.finalPrice };
  }

  function reveal() {
    state.revealed = true;
    state.fb = feedback();
    const f = state.fb;
    log('обратная связь', 'получены факты: ошибка импутации ' + U.fmtPct(f.mae, 1) +
      ', попадание в 90% ДИ ' + U.fmtPct(f.cover, 0) + ', смещение ' + U.fmtPct(f.bias, 1));
    renderAll();
    toast('Фактические данные раскрыты — метрики импутации пересчитаны', 'ok');
  }

  function recalibrate() {
    const before = I.biasAudit(state.mnarShift);
    const suggested = {};
    before.fields.forEach((f) => {
      if (f.type === 'MNAR') suggested[f.id] = f.suggestedFactor;
    });
    state.mnarShift = Object.assign({}, state.mnarShift, suggested);
    const after = I.biasAudit(state.mnarShift);
    state.recal = { before, after, suggested };
    state.retrained = true;
    log('переобучение', 'MNAR-сдвиг перекалиброван: ' +
      before.fields.filter((f) => f.type === 'MNAR').map((f) => D.F[f.id].short.toLowerCase() + ' ×' + f.suggestedFactor.toFixed(2)).join(', '));
    recompute();
    toast('Модель импутации дообучена на отложенной выборке', 'ok');
  }

  /* ============================ рендер: рельс ============================ */
  const STEPS = [
    { title: 'Полный профиль — базовая линия', tab: 'profile', scenario: 'full' },
    { title: 'Клиент не дал согласие: что именно пропало', tab: 'impute', scenario: 'consent' },
    { title: 'Digital Twin: распределение вместо точки', tab: 'twin', scenario: 'consent' },
    { title: 'Данные пришли: ошибка, покрытие, дообучение', tab: 'feedback', scenario: 'consent' },
    { title: 'Риски и контрмеры' , tab: 'risks', scenario: 'adversarial' }
  ];

  function renderRail() {
    const imp = state.imp, sim = state.sim;
    $('clientChip').innerHTML =
      '<span class="dot"></span><b>' + D.client.name + '</b><em>' + D.client.id + ' · ' + D.client.vehicle + '</em>';
    $('clientCard').innerHTML =
      '<div style="display:flex;gap:9px;align-items:flex-start">' +
        '<div style="flex:1">' +
          '<div style="font-weight:600;font-size:12.5px">' + D.client.name + '</div>' +
          '<div class="note">' + D.client.profile + '</div>' +
        '</div>' +
        '<span class="chip mono">' + D.client.id + '</span>' +
      '</div>' +
      '<div style="display:flex;gap:5px;margin-top:9px;flex-wrap:wrap">' +
        '<span class="chip">' + D.client.since + '</span>' +
        (D.client.custom ? '<span class="chip info">свой клиент</span>' : '<span class="chip">демо-клиент</span>') +
        (imp.adversarial.flagged ? '<span class="chip bad">adversarial</span>' : '') +
        '<span class="chip ' + (imp.coverage.missing ? 'warn' : 'ok') + '">' + imp.coverage.missing + ' пропуска</span>' +
      '</div>' +
      '<div class="toolbar" style="margin-top:9px">' +
        '<button class="btn sm" id="newClientBtn">＋ новый клиент</button>' +
        (D.client.custom ? '<button class="btn sm" id="resetClientBtn">вернуть демо-клиента</button>' : '') +
      '</div>';

    const g = state.sim.grade;
    const gCls = g === 'offer' ? 'ok' : g === 'guarded' ? 'warn' : 'bad';
    const gTxt = g === 'offer' ? 'оффер' : g === 'guarded' ? 'условный оффер' : 'запрос данных';
    $('gradeTag').className = 'chip ' + gCls;
    $('gradeTag').innerHTML = '<i class="sw"></i>' + gTxt;
    $('confTag').className = 'chip ' + (imp.coreGap < D.CONF_THRESHOLDS.coreFloor ? 'bad' : 'info');
    $('confTag').textContent = 'уверенность ' + U.fmtPct(imp.sessionConf, 0);
    $('scenTag').className = 'chip';
    $('scenTag').textContent = scenario().title;

    $('railKpis').innerHTML = [
      ['Покрытие', U.fmtPct(imp.coverage.observed / imp.coverage.total, 0)],
      ['Импутация', imp.missingFields.length + ' / ' + imp.coverage.total],
      ['Уверенность', U.fmtPct(imp.sessionConf, 0)],
      ['Режим', state.imp.ensemble.length > 0 ? 'MC×' + state.imp.ensemble.length : '—']
    ].map((k) => '<div class="kpi"><div class="v">' + k[1] + '</div><div class="l">' + k[0] + '</div></div>').join('');

    $('scenarios').innerHTML = D.SCENARIOS.map((s) =>
      '<button class="scen' + (s.id === state.scenarioId ? ' on' : '') + '" data-scen="' + s.id + '">' +
        '<span class="scen-t"><i class="dot-status s-' + (s.tone === 'good' ? 'observed' : s.tone === 'danger' ? 'blocked' : 'missing') + '"></i>' + s.title +
        '<span class="tagm">' + s.hint + '</span></span>' +
      '</button>').join('');
    $('scenNote').innerHTML = '<b>' + scenario().title + '.</b> ' + scenario().note;

    $('steps').innerHTML = STEPS.map((s, i) =>
      '<li class="' + (i === state.step ? 'on' : (i < state.step ? 'done' : '')) + '" data-step="' + i + '">' + s.title + '</li>'
    ).join('');
  }

  /* ============================ рендер: профиль ============================ */
  function renderProfile() {
    const imp = state.imp;
    const byLayer = {};
    D.LAYERS.forEach((l) => { byLayer[l.id] = []; });
    imp.fields.forEach((f) => byLayer[f.layer].push(f));

    $('layers').innerHTML = D.LAYERS.map((L) => {
      const rows = byLayer[L.id];
      const miss = rows.filter((r) => r.status !== 'observed').length;
      return '<div class="layer">' +
        '<div class="layer-h"><h4>' + L.name + '</h4>' +
          (miss ? '<span class="chip warn mono">' + miss + '/' + rows.length + '</span>' : '<span class="chip ok mono">ok</span>') +
          '<span class="src">' + L.source + '</span></div>' +
        '<div class="layer-body">' + rows.map((f) => {
          const val = f.status === 'observed' ? fmtVal(f.id, D.client.truth[f.id])
            : f.status === 'stale' ? fmtVal(f.id, D.client.truth[f.id])
            : f.status === 'blocked' ? '<span style="color:var(--red)">запрещено</span>' : '—';
          const conf = f.status === 'observed' ? 1 : (f.status === 'blocked' ? 0 : f.conf);
          return '<div class="frow" data-feat="' + f.id + '" title="' + U.esc(f.reason || 'нажмите, чтобы изменить доступность') + '">' +
            '<i class="dot-status s-' + f.status + '"></i>' +
            '<span class="fl">' + f.label + (f.pct ? '' : ' <span class="unit">' + f.unit + '</span>') + '</span>' +
            '<span class="fv">' + val + '</span>' +
            (f.status === 'missing' ? typeChip(f.type) : '') +
            '<span class="fconf">' + CH.bar(conf, { h: 4 }) + '</span>' +
          '</div>';
        }).join('') + '</div></div>';
    }).join('');

    const cov = imp.coverage;
    $('coverageCard').innerHTML =
      '<div class="card-h"><h3>Покрытие профиля</h3><span class="spacer"></span>' +
        '<span class="chip mono">' + state.recomputeMs + ' мс' + '</span></div>' +
      CH.stack([
        { label: 'получено', value: cov.observed, color: '#3fd8c4' },
        { label: 'отсутствует', value: cov.missing, color: '#f2b33d' },
        { label: 'устарело', value: cov.stale, color: '#7b8ba6' },
        { label: 'запрещено', value: cov.blocked, color: '#ff7b7b' }
      ], { h: 9 }) +
      '<div style="display:flex;gap:12px;margin-top:9px;flex-wrap:wrap" class="legend">' +
        '<span><i style="background:#3fd8c4"></i>получено ' + cov.observed + '</span>' +
        '<span><i style="background:#f2b33d"></i>отсутствует ' + cov.missing + '</span>' +
        '<span><i style="background:#7b8ba6"></i>устарело ' + cov.stale + '</span>' +
        '<span><i style="background:#ff7b7b"></i>запрещено ' + cov.blocked + '</span>' +
      '</div>' +
      '<div class="note" style="margin-top:9px">Клик по признаку меняет сценарий вручную: получено → MCAR → MAR → MNAR → получено. Модель каждый раз пересчитывается целиком.</div>';

    $('typeLegend').innerHTML =
      '<div class="card-h"><h3>Типизированная пропущенность</h3></div>' +
      '<div class="policy"><div class="ph"><span class="chip ok mono">MCAR</span><b>случайно</b></div>' +
        '<div class="pt">API упал, ответ не дошёл. Пропуск не связан со значением → импутация допустима, доверие высокое.</div></div>' +
      '<div class="policy"><div class="ph"><span class="chip warn mono">MAR</span><b>зависит от наблюдаемых</b></div>' +
        '<div class="pt">Молодые клиенты реже дают согласие. Пропуск объясним известными данными → заполняем по ковариатам, уверенность ниже.</div></div>' +
      '<div class="policy"><div class="ph"><span class="chip bad mono">MNAR</span><b>зависит от скрытого</b></div>' +
        '<div class="pt">Скрывают те, у кого значение хуже (пробег, торможения). Простое заполнение занижает риск → сдвиг приора и расширение интервала.</div></div>';

    $('profileNote').innerHTML =
      '<div class="card-h"><h3>Почему «null» недостаточно</h3></div>' +
      '<div class="quote">Признак «нет данных» ещё не говорит, можно ли им пользоваться. Raw-пропуск не отличает упавший API от намеренного отказа — а от этого зависит и способ заполнения, и право системы принимать решение.</div>' +
      '<div class="note" style="margin-top:8px">Получено <b>' + cov.observed + '</b> из ' + cov.total + ' признаков · пропущено <b>' + cov.missing + '</b> · устарело <b>' + cov.stale + '</b> · запрещено к импутации <b>' + cov.blocked + '</b>.' +
      ' Ключевой (core) признак с минимальной уверенностью: <b>' + imp.coreConf[0].label + '</b> — ' + U.fmtPct(imp.coreConf[0].conf, 0) + '.</div>';
  }

  /* ============================ рендер: импутация ============================ */
  function renderImpute() {
    const imp = state.imp;
    $('badgeProfile').textContent = imp.coverage.total;
    $('badgeImpute').textContent = imp.missingFields.length + imp.staleFields.length;
    $('badgeTwin').textContent = state.sim.grade === 'offer' ? '✓' : '!';

    const list = imp.missingFields.concat(imp.staleFields);
    $('impList').innerHTML = list.length ? list.map((f) => {
      const m = f.imputed;
      const pS = D.popStats[f.id];
      const domLo = Math.min(pS.rawMean - 2 * pS.rawSd, m.lo);
      const domHi = Math.max(pS.rawMean + 2 * pS.rawSd, m.hi);
      const isLog = D.F[f.id].transform === 'log';
      return '<div style="padding:10px 0;border-bottom:1px solid rgba(29,42,66,0.7)">' +
        '<div style="display:flex;align-items:center;gap:7px;flex-wrap:wrap">' +
          '<span style="font-weight:600;font-size:12px">' + f.label + '</span>' +
          typeChip(f.type) + statusChip(f) +
          '<span class="spacer" style="margin-left:auto"></span>' +
          '<span class="chip ' + (f.conf >= 0.6 ? 'ok' : f.conf >= 0.4 ? 'warn' : 'bad') + '" title="уверенность = вероятность, что значение останется в коридоре допуска">уверенность ' + U.fmtPct(f.conf, 0) + '</span>' +
        '</div>' +
        '<div style="display:flex;gap:14px;align-items:center;margin-top:6px">' +
          '<div style="flex:1;min-width:0">' +
            CH.strip({ ciLo: m.lo, ciHi: m.hi, mean: m.mean, min: domLo, max: domHi,
              tolLo: m.band ? m.band.lo : undefined, tolHi: m.band ? m.band.hi : undefined,
              popLo: pS.rawMean - pS.rawSd, popHi: pS.rawMean + pS.rawSd,
              actual: state.revealed ? D.client.truth[f.id] : undefined,
              color: f.conf >= 0.6 ? '#3fd8c4' : f.conf >= 0.4 ? '#f2b33d' : '#ff7b7b' }) +
          '</div>' +
          '<div style="flex:0 0 210px;text-align:right">' +
            '<div style="font-size:13px;font-weight:600">≈ ' + fmtVal(f.id, m.mean) + '</div>' +
            '<div class="note">90% ДИ ' + fmtVal(f.id, m.lo) + ' – ' + fmtVal(f.id, m.hi) + '</div>' +
          '</div>' +
        '</div>' +
        '<div class="note" style="margin-top:5px">' + f.method +
          (f.corrected ? ' · <b>сдвиг приора ×' + m.factor.toFixed(2) + '</b> (без сдвига было бы ' + fmtVal(f.id, m.uncorrectedMean) + ')' : '') +
          (f.status === 'stale' ? ' · данные устарели на ' + f.months + ' мес.' : '') +
          (f.reason ? ' · ' + f.reason : '') +
        '</div>' +
        '<div class="note" style="margin-top:3px">' +
          (m.band ? '<span style="color:var(--teal)">допуск ±' + U.fmtDec(m.band.tol, 2) + 'σ: ' + fmtVal(f.id, m.band.lo) + ' – ' + fmtVal(f.id, m.band.hi) + '</span>' : '') +
          (m.r2 !== undefined && m.r2 !== null
            ? ' · известные признаки объясняют <b>' + U.fmtPct(m.r2, 0) + '</b> разброса признака'
            : '') +
        '</div>' +
      '</div>';
    }).join('') : '<div class="empty">Все признаки получены — импутация не требуется. Это лучший случай, но он же и самый редкий.</div>';

    $('policyCard').innerHTML =
      '<div class="card-h"><h3>Политика по типу пропущенности</h3><span class="spacer"></span>' +
      '<span class="chip mono">σ × ' + I.TYPE_SD_INFLATE.MNAR.toFixed(1) + ' при MNAR</span></div>' +
      '<table class="tbl"><thead><tr><th>Тип</th><th class="num">интервал</th><th>приор</th><th>решение</th></tr></thead><tbody>' +
      ['MCAR', 'MAR', 'MNAR'].map((t) => {
        const confs = imp.missingFields.filter((f) => f.type === t).map((f) => f.conf);
        return '<tr><td>' + typeChip(t) + (confs.length ? ' <span class="chip ' + (U.mean(confs) >= 0.45 ? 'warn' : 'bad') + ' mono">' + U.fmtPct(U.mean(confs), 0) + '</span>' : '') + '</td>' +
          '<td class="num">×' + I.TYPE_SD_INFLATE[t].toFixed(2) + '</td>' +
          '<td class="dim">' + (t === 'MNAR' ? 'сдвиг вверх (скрывают худшие)' : '—') + '</td>' +
          '<td class="dim">' + (t === 'MNAR' ? 'низкая уверенность → запрос данных' : t === 'MAR' ? 'заполняем по ковариатам' : 'заполняем как обычно') + '</td></tr>';
      }).join('') +
      '</tbody></table>' +
      '<div class="note" style="margin-top:9px"><b>Уверенность</b> — это не «качество модели», а вероятность: P(восстановленное значение останется в допуске ±' +
      U.fmtDec(I.TOL.core, 2) + 'σ для ключевого признака, ±' + U.fmtDec(I.TOL.middle, 2) + 'σ для среднего, ±' +
      U.fmtDec(I.TOL.weak, 2) + 'σ для второстепенного). Допуск считается в шкале модели, поэтому «км» не сравниваются с «процентами».' +
      ' Для MNAR добавляется скидка 10 %: сам сдвиг приора — догадка. Серая полоса — допуск, светлая — 90 % ДИ.</div>';

    const blocked = imp.fields.filter((f) => f.status === 'blocked');
    $('sensitiveCard').innerHTML = '<div class="card-h"><h3>Чувствительные признаки</h3></div>' +
      (blocked.length ? blocked.map((f) =>
        '<div style="display:flex;align-items:center;gap:8px;padding:5px 0"><i class="dot-status s-blocked"></i>' +
        '<span style="font-size:11.5px;flex:1">' + f.label + '</span>' +
        '<span class="chip bad">только ручной запрос</span></div>').join('') +
        '<div class="note" style="margin-top:6px">Импутация дохода/финансов запрещена. Модель риска их не использует, поэтому запрет не блокирует расчёт — но и не размывает ответственность.</div>'
        : '<div class="note">В этом сценарии чувствительных пропусков нет. Если они появляются, импутация отключается автоматически.</div>');

    const adv = imp.adversarial;
    $('advCard').innerHTML = '<div class="card-h"><h3>Детектор adversarial-пропусков</h3><span class="spacer"></span>' +
      '<span class="chip ' + (adv.flagged ? 'bad' : 'ok') + '">' + (adv.flagged ? 'сигнал' : 'чисто') + '</span></div>' +
      '<div class="note">' + adv.note + '</div>' +
      '<div style="margin-top:8px">' + D.client.history.map((h) =>
        '<div style="display:flex;gap:8px;font-size:10.5px;color:var(--muted);padding:2px 0">' +
        '<span style="color:var(--dim);flex:0 0 40px">' + h.date + '</span>' +
        '<span style="flex:1">' + h.event + ' · ' + D.F[h.field].short.toLowerCase() + ' <span class="dim">(' + h.via + ')</span></span></div>').join('') +
      '</div>' +
      (adv.flagged ? '<div class="note" style="margin-top:7px;color:var(--amber)">Повторяемость отказа — самостоятельный сигнал, даже если каждое отдельное поле «объяснимо».</div>' : '');
  }

  /* ============================ рендер: Digital Twin ============================ */
  function renderTwin() {
    const sim = state.sim, imp = state.imp;
    const grade = sim.grade;
    const bCls = grade === 'offer' ? 'offer' : grade === 'guarded' ? 'guarded' : 'request';
    let kicker, title, sub;
    if (grade === 'offer') {
      kicker = 'Решение принято';
      title = 'Оффер: ' + sim.chosen.name;
      sub = 'Уверенность решения ' + U.fmtPct(sim.decisionConf, 0) + ' · вариант выигрывает в ' +
        U.fmtPct(sim.stability, 0) + ' симуляций профиля · вероятность продажи ' + U.fmtPct(sim.chosen.buyP, 0) + '.';
    } else if (grade === 'guarded') {
      kicker = 'Решение с оговоркой';
      title = 'Условный оффер: ' + sim.chosen.name;
      sub = 'Уверенность ' + U.fmtPct(sim.decisionConf, 0) + ' ниже комфортного порога — цена включает надбавку за неопределённость ' +
        U.fmtPct(sim.surcharge, 1) + '. Клиент должен видеть, что именно предположено.';
    } else {
      kicker = 'Решение не принято';
      title = 'Нужны данные — оффер не формируется';
      sub = sim.reason === 'core'
        ? 'Ключевой признак «' + sim.reasonField.label + '» восстановлен с уверенностью ' + U.fmtPct(sim.reasonField.conf, 0) +
          ' — ниже порога ' + U.fmtPct(D.CONF_THRESHOLDS.coreFloor, 0) + '. Система не строит рекомендацию на предположении о ключевом риске.'
        : 'Уверенность решения ' + U.fmtPct(sim.decisionConf, 0) + ' ниже порога ' + U.fmtPct(D.CONF_THRESHOLDS.offer, 0) +
          '. Дешевле уточнить данные, чем предложить оффер наугад.';
    }

    $('twinBanner').innerHTML =
      '<div class="banner ' + bCls + '">' +
        '<div class="b-main">' +
          '<div class="b-kicker">' + kicker + '</div>' +
          '<div class="b-title">' + title + '</div>' +
          '<div class="b-sub">' + sub + '</div>' +
        '</div>' +
        '<div class="b-price">' +
          '<div class="p">' + (grade === 'request' ? '—' : U.fmtMoney(sim.finalPrice)) + '</div>' +
          '<div class="l">' + (grade === 'request' ? 'цена не рассчитана' : 'цена для клиента · риск-индекс ×' + U.fmtDec(sim.riskIndexForClient, 2)) + '</div>' +
        '</div>' +
      '</div>';

    const thr = D.CONF_THRESHOLDS;
    const mk = (label, v, note, color) =>
      '<div class="meter"><div class="ml">' + label + '</div>' +
        '<div class="mv" style="color:' + color + '">' + U.fmtPct(v, 0) + '</div>' +
        '<div class="mbar"><i style="width:' + U.clamp(v, 0, 1) * 100 + '%;background:' + color + '"></i>' +
          '<span class="thr" style="left:' + U.clamp(thr.offer, 0, 1) * 100 + '%"></span></div>' +
        '<div class="mnote">' + note + '</div></div>';
    $('twinMeters').innerHTML =
      mk('Уверенность импутации', imp.sessionConf, 'взвешенное геометрическое P(в допуске) по признакам', '#6f9cff') +
      mk('Устойчивость выбора варианта', sim.stability, 'доля симуляций, где победил тот же пакет', '#9b8cff') +
      mk('Уверенность решения', sim.decisionConf, '0,65 · импутация + 0,35 · устойчивость', grade === 'offer' ? '#3fd8c4' : grade === 'guarded' ? '#f2b33d' : '#ff7b7b');

    $('variantTable').innerHTML =
      '<table class="tbl"><thead><tr>' +
        '<th>Пакет</th><th class="num">Цена</th><th class="num">E[выплата]</th><th class="num">Убыт.</th>' +
        '<th class="num">P(куп)</th><th class="num">E[прибыль]</th><th class="num">P(убыток)</th>' +
      '</tr></thead><tbody>' +
      sim.variants.map((v, i) => {
        const hl = i === sim.chosenIdx;
        return '<tr class="' + (hl ? 'hl' : '') + '">' +
          '<td><div class="strong">' + v.name + (hl ? ' <span class="chip ok sm">рекомендован</span>' : '') + '</div>' +
            '<div class="note">' + v.cover + ' · ' + v.desc + '</div></td>' +
          '<td class="num strong">' + U.fmtMoney(v.price) + '</td>' +
          '<td class="num">' + U.fmtMoney(v.paid) + '</td>' +
          '<td class="num">' + U.fmtDec(v.lossRatio, 2) + '</td>' +
          '<td class="num">' + U.fmtPct(v.buyP, 0) + '</td>' +
          '<td class="num"><div class="strong" style="color:' + (v.expProfit > 0 ? 'var(--teal)' : 'var(--red)') + '">' + U.fmtMoney(v.expProfit) + '</div>' +
            '<div style="width:64px;margin-left:auto;margin-top:2px">' +
              CH.strip({ ciLo: v.profitLo, ciHi: v.profitHi, mean: v.profitMedian, min: Math.min(v.profitLo, -2000), max: v.profitHi, color: v.expProfit > 0 ? '#3fd8c4' : '#ff7b7b', w: 64, h: 14 }) +
            '</div></td>' +
          '<td class="num" style="color:' + (v.pNegative > 0.15 ? 'var(--amber)' : 'var(--dim)') + '">' + U.fmtPct(v.pNegative, 0) + '</td>' +
        '</tr>';
      }).join('') + '</tbody></table>' +
      '<div class="note" style="margin-top:8px">E[прибыль] = цена × 0,84 − 2 400 ₽ привлечения − ожидаемая выплата, взвешенная на вероятность покупки. Полоска под прибылью — 10–90 перцентили по ансамблю профилей.</div>';

    const ch = sim.chosen;
    const flat = sim.profitSpread < 1;
    $('profitHist').innerHTML = flat
      ? '<div style="padding:14px 4px 4px">' +
          '<div class="note" style="margin-bottom:6px">Разброса нет: профиль известен точно (ансамбль вырожден в точку). Прибыль сделки:</div>' +
          '<div style="font-size:26px;font-weight:650;letter-spacing:-0.03em;color:' + (ch.profitMedian > 0 ? 'var(--teal)' : 'var(--red)') + '">' + U.fmtMoney(ch.profitMedian) + '</div>' +
          '<div class="note" style="margin-top:8px">Включите ансамблевую симуляцию или добавьте пропуски — и распределение появится. Именно отсутствие разброса и есть «ложная уверенность», а не признак точности.</div>' +
        '</div>'
      : CH.hist(ch.draws, {
          w: 520, h: 130, bins: 24, zero: true, fill: ch.expProfit > 0 ? '#3fd8c4' : '#ff7b7b',
          marks: [
            { x: ch.profitLo, label: 'p10', color: '#9b8cff' },
            { x: ch.profitMedian, label: 'медиана', color: '#eaeef7' },
            { x: ch.profitHi, label: 'p90', color: '#9b8cff' }
          ],
          fmt: (v) => fmtShort(v)
        }) +
        '<div class="legend" style="margin-top:6px">' +
          '<span><i style="background:#9b8cff"></i>10–90 перцентиль разброса прибыли</span>' +
          '<span><i style="background:#ff7b7b"></i>зона убытка</span>' +
          '<span>P(убыток) ' + U.fmtPct(ch.pNegative, 0) + ' · E[прибыль] ' + U.fmtMoney(ch.expProfit) + '</span>' +
        '</div>' +
        '<div class="note" style="margin-top:6px">Разброс возникает не из случайности убытков, а из неопределённости <b>профиля</b>: каждая из 20 цепочек импутации — свой мир, и в каждом прибыль разная.</div>';

    /* ---- ценность запроса данных ---- */
    const voi = state.voi;
    const needGate = grade !== 'offer';
    $('voiCard').innerHTML =
      '<div class="card-h"><h3>Что даст запрос данных</h3><span class="spacer"></span>' +
        '<span class="chip ' + (needGate ? 'bad' : 'info') + '">' + (needGate ? 'обязательно для оффера' : 'опционально') + '</span></div>' +
      (needGate ? '<div class="note" style="margin-bottom:8px">Система ранжирует запросы по тому, насколько каждый признак сдвигает уверенность решения, — а не по «важности» в вакууме.</div>' : '') +
      (voi.length ? '<table class="tbl"><thead><tr><th>Запрос</th><th>тип</th><th>ширина ДИ</th><th class="num">уверенность после</th><th class="num">Δ</th><th></th></tr></thead><tbody>' +
        voi.slice(0, 4).map((v) => '<tr>' +
          '<td>' + v.label + '</td><td>' + typeChip(v.type) + '</td>' +
          '<td class="num dim">' + (v.reach ? '×' + U.fmtDec(1 + v.reach, 1) : '—') + '</td>' +
          '<td class="num">' + U.fmtPct(v.confAfter, 0) + '</td>' +
          '<td class="num" style="color:' + (v.gainConf > 0.02 ? 'var(--teal)' : 'var(--dim)') + '">' + U.fmtSignedPct(v.gainConf, 1) + '</td>' +
          '<td><button class="btn sm" data-req="' + v.id + '">запросить</button></td>' +
        '</tr>').join('') + '</tbody></table>'
        : '<div class="empty">Все признаки получены — запрашивать нечего.</div>') +
      '<div class="note" style="margin-top:8px">Δ — прирост уверенности решения, если признак станет известен (усреднено по 20/50/80 перцентилям его распределения).</div>';

    /* ---- объяснимость ---- */
    const ex = state.explain;
    const impShare = ex.impShare;
    const noOffer = state.sim.grade === 'request';
    $('explainCard').innerHTML =
      '<div class="card-h"><h3>Как предположения попали в цену</h3><span class="spacer"></span>' +
      '<span class="chip ' + (impShare > 0.2 ? 'warn' : 'ok') + '">' + U.fmtPct(impShare, 0) + ' цены — из импутации</span></div>' +
      CH.contrib(ex.items, { w: 500 }) +
      '<div style="display:flex;gap:14px;align-items:baseline;margin-top:6px;flex-wrap:wrap">' +
        '<div class="note">Базовый тариф «' + ch.name + '»: <b>' + U.fmtMoney(ex.base) + '</b> · риск-индекс ×' + U.fmtDec(ex.riskIndex, 2) + '</div>' +
        '<div style="margin-left:auto;font-size:12px">' + (noOffer ? 'справочно: ' : 'итог: ') + '<b>' + U.fmtMoney(ex.price) + '</b></div>' +
      '</div>' +
      (noOffer ? '<div class="note" style="margin-top:5px;color:var(--amber)">Цена показана справочно: оффер не выставляется, пока ключевой признак не уточнён.</div>' : '') +
      '<div class="note" style="margin-top:7px">Фиолетовым помечены признаки, которых нет в данных: именно их вклад клиент видит как предположение. Отдельная строка — надбавка за неопределённость. Разложение первого порядка: сумма вкладов, нормированных на популяцию, приближает итог цены.</div>';
  }

  /* ============================ рендер: обратная связь ============================ */
  function renderFeedback() {
    const imp = state.imp;
    if (!state.revealed) {
      $('fbState').innerHTML =
        '<div class="card-h"><h3>Обратная связь</h3><span class="spacer"></span><span class="chip">шаг 4</span></div>' +
        '<div class="quote">Когда реальные данные приходят (клиент дал согласие, API восстановился), система сравнивает импутированное значение с фактическим и дообучает модель.</div>' +
        '<div style="display:flex;gap:10px;align-items:center;margin-top:12px;flex-wrap:wrap">' +
          '<button class="btn primary" id="revealBtn">Данные пришли →</button>' +
          '<span class="note">Раскроем факты по ' + (imp.missingFields.length + imp.staleFields.length) + ' признакам и посмотрим, врала ли модель.</span>' +
        '</div>' +
        '<div style="display:flex;gap:6px;margin-top:10px;flex-wrap:wrap">' +
          imp.missingFields.concat(imp.staleFields).map((f) => '<span class="chip warn">' + f.label + '</span>').join('') +
        '</div>';
      $('fbTable').innerHTML = '<div class="empty">Нет фактов — нет метрик. Это честно: до появления данных качество импутации неизвестно.</div>';
      $('fbMetrics').innerHTML = '';
      $('retrainCard').innerHTML = '';
      $('calibCard').innerHTML = '';
      return;
    }
    const fb = state.fb;
    $('fbState').innerHTML =
      '<div class="card-h"><h3>Сравнение импутации с фактом</h3><span class="spacer"></span>' +
        '<span class="chip ok">данные раскрыты</span></div>' +
      '<div class="note">Столбец «Δ» — относительная ошибка оценки. «В ДИ» — попал ли факт в 90% интервал, обещанный моделью.</div>';

    $('fbTable').innerHTML = '<table class="tbl"><thead><tr>' +
      '<th>Признак</th><th>тип</th><th class="num">оценка</th><th class="num">факт</th><th class="num">Δ</th><th class="num">уверенность</th><th>в ДИ</th>' +
      '</tr></thead><tbody>' + fb.rows.map((r) =>
        '<tr><td>' + r.label + '</td><td>' + typeChip(r.type) + '</td>' +
        '<td class="num">' + fmtVal(r.id, r.est) + '</td>' +
        '<td class="num strong">' + fmtVal(r.id, r.actual) + '</td>' +
        '<td class="num" style="color:' + (Math.abs(r.err) > 0.15 ? 'var(--red)' : 'var(--muted)') + '">' + U.fmtSignedPct(r.err, 1) + '</td>' +
        '<td class="num dim">' + U.fmtPct(r.conf, 0) + '</td>' +
        '<td>' + (r.inCI ? '<span class="chip ok">да</span>' : '<span class="chip bad">нет</span>') + '</td></tr>').join('') +
      '</tbody></table>';

    $('fbMetrics').innerHTML =
      '<div class="card-h"><h3>Метрики контура</h3></div>' +
      '<div class="kpis" style="grid-template-columns:1fr 1fr">' +
        '<div class="kpi"><div class="v">' + U.fmtPct(fb.mae, 1) + '</div><div class="l">MAE (ср. ошибка)</div></div>' +
        '<div class="kpi"><div class="v" style="color:' + (fb.cover >= 0.8 ? 'var(--teal)' : 'var(--red)') + '">' + U.fmtPct(fb.cover, 0) + '</div><div class="l">покрытие 90% ДИ</div></div>' +
        '<div class="kpi"><div class="v" style="color:' + (Math.abs(fb.bias) > 0.1 ? 'var(--amber)' : 'var(--text)') + '">' + U.fmtSignedPct(fb.bias, 1) + '</div><div class="l">систематическое смещение</div></div>' +
        '<div class="kpi"><div class="v">' + U.fmtMoney(fb.cf.price - fb.priceNow) + '</div><div class="l">недобор цены</div></div>' +
      '</div>' +
      '<div class="note" style="margin-top:10px">Если бы данные были известны: риск-индекс ×' + U.fmtDec(fb.cf.riskIndex, 2) +
        ', цена ' + U.fmtMoney(fb.cf.price) + ' вместо ' + U.fmtMoney(fb.priceNow) + ', фактическая прибыль сделки ' +
        U.fmtMoney(fb.cf.profit) + '.</div>' +
      '<div class="note" style="margin-top:6px;color:' + (fb.cf.profit < 0 ? 'var(--red)' : 'var(--muted)') + '">' +
        (fb.cf.profit < 0 ? 'Оффер на заниженном пробеге убыточен: занижение MNAR-признака прямо превращается в потерю денег.' : 'Сделка остаётся прибыльной, но цена была занижена.') + '</div>';

    const rec = state.recal;
    $('retrainCard').innerHTML =
      '<div class="card-h"><h3>Переобучение импутации</h3><span class="spacer"></span>' +
        (state.retrained ? '<span class="chip ok">дообучено</span>' : '<span class="chip warn">нужно дообучение</span>') + '</div>' +
      '<div class="note">Сдвиг приора MNAR оценивается на отложенной выборке из 120 клиентов: у них прячем признак по MNAR-механизму (только у «худших»), импутируем и сравниваем с фактом.</div>' +
      '<div class="toolbar" style="margin-top:9px"><button class="btn primary sm" id="retrainBtn" ' + (state.retrained ? 'disabled' : '') + '>' +
        (state.retrained ? 'модель уже дообучена' : 'Перекалибровать MNAR-сдвиг') + '</button></div>' +
      (rec ? '<table class="tbl" style="margin-top:10px"><thead><tr><th>Признак</th><th class="num">сдвиг</th><th class="num">MAE было</th><th class="num">MAE стало</th><th class="num">смещение было</th><th class="num">смещение стало</th></tr></thead><tbody>' +
        rec.after.fields.map((f) => {
          const b = rec.before.fields.filter((x) => x.id === f.id)[0];
          const maeBetter = f.mae <= b.mae;
          const biasBetter = Math.abs(f.bias) <= Math.abs(b.bias);
          return '<tr><td>' + D.F[f.id].label + '</td><td class="num">×' + U.fmtDec(f.factor, 2) + '</td>' +
            '<td class="num dim">' + U.fmtPct(b.mae, 1) + '</td>' +
            '<td class="num" style="color:' + (maeBetter ? 'var(--teal)' : 'var(--amber)') + '">' + U.fmtPct(f.mae, 1) + '</td>' +
            '<td class="num dim">' + U.fmtSignedPct(b.bias, 1) + '</td>' +
            '<td class="num" style="color:' + (biasBetter ? 'var(--teal)' : 'var(--amber)') + '">' + U.fmtSignedPct(f.bias, 1) + '</td></tr>';
        }).join('') + '</tbody></table>' : '') +
      (rec ? '<div class="note" style="margin-top:7px">Коэффициент сдвига = отношение фактического среднего к импутированному на 120 отложенных клиентах — это и есть петля обратной связи. Устранение смещения может слегка поднять MAE: модель перестаёт систематически занижать, но растёт разброс.</div>' : '');

    $('calibCard').innerHTML =
      '<div class="card-h"><h3>Калибровка на отложенной выборке</h3><span class="spacer"></span>' +
        '<span class="chip mono">n = ' + (rec ? rec.after.fields[0].n : 0) + '</span></div>' +
      (rec ? '<div class="legend" style="margin-bottom:8px"><span><i style="background:#7b8ba6"></i>до калибровки</span><span><i style="background:#3fd8c4"></i>после</span></div>' +
        rec.after.fields.map((f) => {
          const b = rec.before.fields.filter((x) => x.id === f.id)[0];
          const max = Math.max(Math.abs(b.bias), Math.abs(f.bias), 0.02);
          return '<div style="margin-bottom:10px">' +
            '<div style="display:flex;justify-content:space-between;font-size:11px"><span>' + D.F[f.id].label + '</span>' +
            '<span class="dim">смещение</span></div>' +
            '<div class="ch-mini" style="height:6px;margin-top:4px"><span style="width:' + (Math.abs(b.bias) / max * 100) + '%;background:#7b8ba6"></span></div>' +
            '<div class="ch-mini" style="height:6px;margin-top:3px"><span style="width:' + (Math.abs(f.bias) / max * 100) + '%;background:#3fd8c4"></span></div>' +
            '<div class="note" style="margin-top:2px">' + U.fmtSignedPct(b.bias, 1) + ' → ' + U.fmtSignedPct(f.bias, 1) + '</div>' +
          '</div>';
        }).join('')
        : '<div class="empty">Нажмите «Перекалибровать», чтобы увидеть смещение до и после.</div>');
  }

  /* ============================ рендер: риски ============================ */
  function renderRisks() {
    const imp = state.imp, sim = state.sim, fb = state.fb, ex = state.explain;
    const idx = D.pop.map((r) => TW.riskIndex(r));
    const income = D.pop.map((r) => r.income);
    const cIncome = U.corr(idx, income);
    const cRegion = U.corr(idx, D.pop.map((r) => r.district_risk));
    const impShare = ex.impShare;
    const adv = imp.adversarial;

    const rc = (title, tag, tagCls, desc, metric, metricLabel, note) =>
      '<div class="riskcard"><div class="rh"><h4>' + title + '</h4><span class="spacer" style="margin-left:auto"></span>' +
      '<span class="chip ' + tagCls + '">' + tag + '</span></div>' +
      '<div class="rd">' + desc + '</div>' +
      '<div class="rm"><span class="v">' + metric + '</span><span class="l">' + metricLabel + '</span></div>' +
      (note ? '<div class="note" style="margin-top:6px">' + note + '</div>' : '') + '</div>';

    $('riskCards').innerHTML =
      rc('Ложная уверенность импутации',
        fb ? (fb.cover >= 0.8 ? 'покрытие в норме' : 'интервал врёт') : 'проверка неполная',
        fb ? (fb.cover >= 0.8 ? 'ok' : 'bad') : 'warn',
        'Модель заполняет пропуск правдоподобным, но неверным значением — и двойник строит оффер на ложной основе.',
        fb ? U.fmtPct(fb.cover, 0) : '—', 'покрытие 90% ДИ (факт внутри интервала)',
        fb ? 'MAE ' + U.fmtPct(fb.mae, 1) + ' · смещение ' + U.fmtSignedPct(fb.bias, 1) : 'Раскройте факты в «Обратной связи», чтобы измерить.')

      + rc('Каскадная ошибка',
        (fb && fb.cf.profit < 0) ? 'прибыль сменила знак' : 'сделка устойчива',
        (fb && fb.cf.profit < 0) ? 'bad' : 'ok',
        'Ошибка импутации усиливается симуляцией: двойник выдаёт уверенную, но неверную рекомендацию.',
        U.fmtPct(Math.abs(sim.riskIndexForClient - (fb ? fb.cf.riskIndex : sim.riskIndexForClient)) / Math.max(sim.riskIndexForClient, 1e-6), 0),
        'сдвиг риск-индекса при известных данных',
        'Заниженный пробег → заниженный риск-индекс → цена ниже справедливой.')

      + rc('Adversarial-пропуски', adv.flagged ? 'детектор сработал' : 'не обнаружено', adv.flagged ? 'warn' : 'ok',
        'Клиент намеренно не даёт данные, зная, что импутация заполнит их в его пользу.',
        adv.flagged ? U.fmtPct(adv.score, 0) : '0%', 'оценка систематичности отказов',
        adv.note)

      + rc('Прокси-дискриминация', cIncome > 0.35 ? 'есть косвенная связь' : 'в пределах нормы', cIncome > 0.35 ? 'warn' : 'ok',
        'Импутированные признаки могут неявно кодировать чувствительные атрибуты (доход, район).',
        U.fmtDec(cIncome, 2), 'corr(риск-индекс, доход) на популяции',
        'Район входит в тариф напрямую (corr с районом ' + U.fmtDec(cRegion, 2) + '), а доход — только косвенно. Fairness-аудит смотрит именно на такие обходные пути.')

      + rc('Утечка через импутацию', impShare > 0.35 ? 'высокая доля' : 'умеренно', impShare > 0.35 ? 'warn' : 'ok',
        'Если механизм импутации известен, по заполненным значениям можно восстановить, что именно клиент скрыл.',
        U.fmtPct(impShare, 0), 'доля цены, построенной на импутации',
        'Чем выше доля, тем важнее не отдавать клиенту «формулу» заполнения и разделять контуры.')

      + rc('Некорректность на редких сегментах', imp.coverage.observed < 8 ? 'данных мало' : 'достаточно', imp.coverage.observed < 8 ? 'warn' : 'ok',
        'Там, где истории мало, импутация особенно ненадёжна, а двойник особенно уверен.',
        imp.coverage.observed + '/' + imp.coverage.total, 'наблюдаемых признаков из ' + imp.coverage.total,
        'Сегмент проверяется по числу доноров в обучающей выборке; при редком сегменте интервал расширяется.');

    const c = state.controls;
    const rows = [
      ['sensitive', 'Запрет импутации чувствительных признаков', 'доход, финансы — только ручной запрос'],
      ['gate', 'Порог уверенности и floor по core-признакам', 'ниже порога — не оффер, а запрос данных'],
      ['ensemble', 'Ансамблевая симуляция вместо точечной', 'Monte Carlo по 20 цепочкам импутации'],
      ['logging', 'Логирование решений на импутированных данных', 'что заполнено, с какой уверенностью, что решили'],
      ['fairness', 'Fairness-аудит на импутированных данных', 'проверка прокси-связей с доходом и районом'],
      ['contours', 'Разделение контуров: импутация ≠ деньги', 'импутация видит только профиль, не цену']
    ];
    $('controlsCard').innerHTML = '<div class="card-h"><h3>Контрмеры</h3><span class="spacer"></span><span class="chip mono">клик — включить/выключить</span></div>' +
      '<div class="ctrl-list">' + rows.map((r) =>
        '<button class="ctrl ' + (c[r[0]] ? 'on' : '') + '" data-ctrl="' + r[0] + '">' +
          '<span class="sw2"></span><span class="cl">' + r[1] + '</span><span class="cd">' + r[2] + '</span></button>').join('') + '</div>' +
      '<div class="note" style="margin-top:9px">Выключите «порог уверенности» или «ансамблевую симуляцию» — и увидите, как система начинает выдавать уверенный оффер на пустом месте. Это ровно та деградация, от которой защищают контрмеры.</div>';

    $('auditTable').innerHTML =
      '<div class="card-h"><h3>Аудит решений</h3><span class="spacer"></span>' +
        '<button class="btn sm" id="exportBtn">выгрузить протокол</button></div>' +
      (state.audit.length ? '<div class="audit">' + state.audit.slice(0, 14).map((a) =>
        '<div class="row"><span class="t">' + a.t + '</span><span class="k">' + U.esc(a.kind) + '</span><span class="m">' + U.esc(a.msg) + '</span></div>').join('') + '</div>'
        : '<div class="empty">Журнал пуст — включите логирование.</div>');
  }

  /* ============================ создание клиента ============================ */
  const STORE_KEY = 'dtwin.client.v1';
  let draft = null;      // черновик формы
  let draftPreset = null;

  function newId() { return D.makeId(); }

  function historyFromChoice(choice) {
    const d = new Date().toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
    if (choice === 'once') {
      return [{ date: d, field: 'mileage', event: 'отказ в доступе к телематике', via: 'приложение' }];
    }
    if (choice === 'twice') {
      return [
        { date: d, field: 'mileage', event: 'отказ в доступе к телематике', via: 'приложение' },
        { date: d, field: 'mileage', event: 'повторный отказ', via: 'приложение' },
        { date: d, field: 'hard_braking', event: 'отказ в доступе к телематике', via: 'приложение' }
      ];
    }
    return [];
  }

  function historyChoice(spec) {
    const h = spec.history || [];
    const n = h.filter((x) => x.field === 'mileage').length;
    return n >= 2 ? 'twice' : n === 1 ? 'once' : 'none';
  }

  function openClient(spec) {
    spec = spec || D.client;
    draft = {
      id: spec.id || newId(),
      name: spec.name || '',
      vehicle: spec.vehicle || '',
      district: spec.district || D.DISTRICTS_NAMES[2],
      truth: Object.assign({}, D.client.truth, spec.truth || {}),
      historyChoice: historyChoice(spec)
    };
    draftPreset = null;
    renderModal();
    $('clientModal').classList.add('on');
  }

  function closeClient() {
    $('clientModal').classList.remove('on');
    draft = null; draftPreset = null;
  }

  function renderModal() {
    const t = draft.truth;
    $('modalIdChip').textContent = draft.id;

    $('presetList').innerHTML = D.PRESETS.map((p) =>
      '<button class="preset' + (draftPreset === p.key ? ' on' : '') + '" data-preset="' + p.key + '">' +
        '<b>' + p.title + '</b><span>' + p.hint + '</span></button>').join('') +
      '<button class="preset' + (draftPreset === 'custom' ? ' on' : '') + '" data-preset="custom">' +
        '<b>Свой вариант</b><span>значения текущего клиента</span></button>';

    const numVal = (f) => {
      const v = t[f.id] !== undefined ? t[f.id] : D.popStats[f.id].rawMean;
      return f.pct || f.d ? Number(v).toFixed(f.pct ? 2 : f.d) : String(Math.round(v));
    };
    const fields = D.FEATURES.map((f) =>
      '<div class="field" data-field="' + f.id + '">' +
        '<label for="cf-' + f.id + '">' + f.label + (f.sens ? ' · чувствительный' : '') + '</label>' +
        '<input id="cf-' + f.id + '" data-fid="' + f.id + '" type="number" step="' + (f.pct ? 0.01 : (f.d ? 0.1 : 1)) +
          '" min="' + f.min + '" max="' + f.max + '" value="' + numVal(f) + '">' +
        '<div class="u">' + (f.unit ? f.unit + ' · ' : '') + 'μ ' + U.fmtNum(D.popStats[f.id].rawMean, f.pct ? 2 : 0) + '</div>' +
      '</div>').join('');

    $('clientForm').innerHTML =
      '<div class="form">' +
        '<div class="field"><label for="cf-name">Имя клиента</label><input id="cf-name" value="' + U.esc(draft.name) + '"><div class="u">для подписи в карточке</div></div>' +
        '<div class="field"><label for="cf-vehicle">Автомобиль</label><input id="cf-vehicle" value="' + U.esc(draft.vehicle) + '"><div class="u">марка, модель, год</div></div>' +
        '<div class="field"><label for="cf-district">Район</label><select id="cf-district">' +
          D.DISTRICTS_NAMES.map((n) => '<option' + (n === draft.district ? ' selected' : '') + '>' + n + '</option>').join('') +
        '</select><div class="u">название района</div></div>' +
        '<div class="field"><label for="cf-history">История отказов</label><select id="cf-history">' +
          [['none', 'нет отказов'], ['once', 'один отказ по телематике'], ['twice', 'повторные отказы (детектор)']]
            .map((o) => '<option value="' + o[0] + '"' + (draft.historyChoice === o[0] ? ' selected' : '') + '>' + o[1] + '</option>').join('') +
        '</select><div class="u">влияет на adversarial-детектор</div></div>' +
        fields +
      '</div>';

    updateWarnings();
  }

  function readDraft() {
    const truth = {};
    D.FEATURES.forEach((f) => {
      const el = $('cf-' + f.id);
      let v = el ? Number(el.value) : NaN;
      if (!isFinite(v) || el.value === '') v = D.popStats[f.id].rawMean;
      truth[f.id] = U.clamp(v, f.min, f.max);
    });
    return {
      id: draft.id,
      name: ($('cf-name').value || '').trim() || 'Новый клиент',
      vehicle: ($('cf-vehicle').value || '').trim() || 'Авто клиента',
      district: $('cf-district').value,
      truth: truth,
      history: historyFromChoice($('cf-history').value),
      custom: true
    };
  }

  function updateWarnings() {
    if (!draft) return;
    const spec = readDraft();
    const w = D.validateClient(spec);
    D.FEATURES.forEach((f) => {
      const wrap = document.querySelector('[data-field="' + f.id + '"]');
      if (!wrap) return;
      const el = $('cf-' + f.id);
      const raw = Number(el.value);
      wrap.classList.toggle('bad', !isFinite(raw) || raw < f.min || raw > f.max);
    });
    $('formWarn').innerHTML = w.length
      ? '<b style="color:var(--amber)">Проверьте ввод:</b> ' + w.join(' · ') +
        '<br><span style="color:var(--dim)">Можно применить и так — система честно покажет широкий интервал и низкую уверенность. Значения обрезаются в допустимые границы признака.</span>'
      : '<b style="color:var(--teal)">Профиль в правдоподобных границах.</b> ' +
        '<span style="color:var(--dim)">Можно применять: подпись клиента, риск-индекс и цена пересчитаются.</span>';
  }

  function syncDraftFromInputs() {
    if (!$('cf-name')) return;
    draft.name = $('cf-name').value;
    draft.vehicle = $('cf-vehicle').value;
    draft.district = $('cf-district').value;
    draft.historyChoice = $('cf-history').value;
    D.FEATURES.forEach((f) => {
      const el = $('cf-' + f.id);
      if (el) draft.truth[f.id] = Number(el.value);
    });
  }

  function applyPreset(key) {
    draftPreset = key;
    if (key === 'custom') {
      syncDraftFromInputs();
      renderModal();
      return;
    }
    const p = D.PRESETS.filter((x) => x.key === key)[0];
    if (!p) return;
    draft.truth = Object.assign({}, p.truth);
    draft.vehicle = p.vehicle;
    draft.district = p.district;
    draft.historyChoice = p.history.length ? historyChoice({ history: p.history }) : 'none';
    draft.name = D.NAMES[(D.PRESETS.indexOf(p) * 3 + 1) % D.NAMES.length];
    renderModal();
  }

  function applyRandomClient() {
    const c = D.randomClient();
    draft = {
      id: c.id, name: c.name, vehicle: c.vehicle, district: c.district || D.DISTRICTS_NAMES[2],
      truth: c.truth, historyChoice: 'none'
    };
    draftPreset = 'custom';
    renderModal();
    toast('Случайный клиент из популяции подставлен в форму', 'ok');
  }

  function applyDraft() {
    const spec = readDraft();
    D.client = D.makeClient(spec);
    state.revealed = false;
    state.retrained = false;
    state.recal = null;
    state.fb = null;
    const sc = scenario();
    state.states = JSON.parse(JSON.stringify(sc.states));
    try { localStorage.setItem(STORE_KEY, JSON.stringify(spec)); } catch (e) { /* приватный режим */ }
    log('клиент', 'создан ' + D.client.id + ' · ' + D.client.name + ' · ' + D.client.profile);
    closeClient();
    recompute();
    toast('Клиент ' + D.client.id + ' создан — профиль пересчитан', 'ok');
  }

  function resetClient() {
    D.client = D.makeClient(D.DEFAULT_SPEC);
    try { localStorage.removeItem(STORE_KEY); } catch (e) {}
    state.revealed = false; state.retrained = false; state.recal = null; state.fb = null;
    log('клиент', 'возврат к демо-клиенту ' + D.client.id);
    recompute();
    toast('Возвращён демо-клиент А. Волков', 'ok');
  }

  function restoreClient() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return false;
      const spec = JSON.parse(raw);
      if (!spec || !spec.truth) { localStorage.removeItem(STORE_KEY); return false; }
      D.client = D.makeClient(spec);
      return true;
    } catch (e) { return false; }
  }

  /* ============================ общий рендер ============================ */
  function renderAll() {
    state.recomputeMs = state.recomputeMs || 0;
    renderRail();
    renderProfile();
    renderImpute();
    renderTwin();
    renderFeedback();
    renderRisks();
  }

  /* ============================ события ============================ */
  function bind() {
    $('scenarios').addEventListener('click', (e) => {
      const b = e.target.closest('[data-scen]');
      if (b) { setScenario(b.dataset.scen); }
    });
    $('steps').addEventListener('click', (e) => {
      const li = e.target.closest('[data-step]');
      if (!li) return;
      const i = +li.dataset.step;
      state.step = i;
      const s = STEPS[i];
      setScenario(s.scenario, true);
      switchTab(s.tab);
      log('демо', 'шаг ' + (i + 1) + ': ' + s.title);
      renderRail();
    });
    $('nextStep').addEventListener('click', () => {
      state.step = Math.min(state.step + 1, STEPS.length - 1);
      const s = STEPS[state.step];
      setScenario(s.scenario, true);
      switchTab(s.tab);
      log('демо', 'шаг ' + (state.step + 1) + ': ' + s.title);
      renderRail();
    });
    $('resetDemo').addEventListener('click', () => {
      state.step = 0;
      state.audit = [];
      state.mnarShift = {};
      setScenario('full', true);
      switchTab('profile');
      renderRail();
      toast('Демонстрация сброшена', 'ok');
    });

    $('tabs').addEventListener('click', (e) => {
      const b = e.target.closest('[data-tab]');
      if (b) switchTab(b.dataset.tab);
    });

    document.body.addEventListener('click', (e) => {
      const f = e.target.closest('[data-feat]');
      if (f) { cycleFeature(f.dataset.feat); return; }
      const req = e.target.closest('[data-req]');
      if (req) { requestData(req.dataset.req); return; }
      const ctr = e.target.closest('[data-ctrl]');
      if (ctr) { toggleControl(ctr.dataset.ctrl); return; }
      const pr = e.target.closest('[data-preset]');
      if (pr) { applyPreset(pr.dataset.preset); return; }
      if (e.target.id === 'revealBtn') { reveal(); return; }
      if (e.target.id === 'retrainBtn') { recalibrate(); return; }
      if (e.target.id === 'exportBtn') { exportAudit(); return; }
      if (e.target.id === 'newClientBtn') { openClient(D.client); return; }
      if (e.target.id === 'resetClientBtn') { resetClient(); return; }
      if (e.target.id === 'modalClose' || e.target.id === 'modalCancel') { closeClient(); return; }
      if (e.target.id === 'applyClient') { applyDraft(); return; }
      if (e.target.id === 'randomClient') { applyRandomClient(); return; }
      if (e.target.id === 'clientModal') { closeClient(); return; }
    });

    document.addEventListener('input', (e) => {
      if (e.target.closest('#clientForm')) updateWarnings();
    });
    document.addEventListener('change', (e) => {
      if (e.target.closest('#clientForm')) updateWarnings();
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && $('clientModal').classList.contains('on')) { closeClient(); return; }
      if (e.key === 'ArrowRight' && !$('clientModal').classList.contains('on') &&
        !/input|textarea|select/i.test(document.activeElement.tagName)) {
        $('nextStep').click();
      }
    });
  }

  function switchTab(id) {
    state.activeTab = id;
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('on', t.dataset.tab === id));
    document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('on', p.id === 'panel-' + id));
    if (id === 'twin') renderTwin();
    if (id === 'feedback') renderFeedback();
  }

  function toggleControl(key) {
    state.controls[key] = !state.controls[key];
    const names = {
      sensitive: 'запрет импутации чувствительных',
      gate: 'порог уверенности',
      ensemble: 'ансамблевая симуляция',
      logging: 'логирование',
      fairness: 'fairness-аудит',
      contours: 'разделение контуров'
    };
    log('контрмера', names[key] + ' → ' + (state.controls[key] ? 'включено' : 'ВЫКЛЮЧЕНО'));
    if (key === 'logging') { renderRisks(); return; }
    recompute();
    if (!state.controls.gate && state.sim.grade === 'offer' && state.imp.coreGap < D.CONF_THRESHOLDS.coreFloor) {
      toast('Порог отключён: оффер выдан на ключевом признаке с уверенностью ' + U.fmtPct(state.imp.coreGap, 0) + '. Это то, от чего защищает гейт.', 'warn');
    }
    if (!state.controls.ensemble) {
      toast('Ансамбль отключён: осталась одна «истина». Уверенность выросла, ошибка — тоже.', 'warn');
    }
  }

  function requestData(id) {
    const f = state.imp.byId[id];
    state.states[id] = { status: 'observed' };
    log('запрос данных', 'признак «' + f.label + '» получен от клиента/источника');
    recompute();
    toast('«' + f.label + '» получен — профиль пересчитан с учётом факта', 'ok');
  }

  function exportAudit() {
    const payload = {
      клиент: D.client.id,
      сценарий: scenario().title,
      решение: state.sim.grade,
      выбранный_пакет: state.sim.grade === 'request' ? null : state.sim.chosen.name,
      цена: state.sim.grade === 'request' ? null : Math.round(state.sim.finalPrice),
      уверенность_решения: +state.sim.decisionConf.toFixed(3),
      уверенность_импутации: +state.imp.sessionConf.toFixed(3),
      устойчивость_выбора: +state.sim.stability.toFixed(3),
      импутировано: state.imp.missingFields.map((f) => ({ признак: f.label, тип: f.type, оценка: Math.round(f.imputed.mean), интервал: [Math.round(f.imputed.lo), Math.round(f.imputed.hi)], уверенность: +f.conf.toFixed(2) })),
      запрещено_к_импутации: state.imp.fields.filter((f) => f.status === 'blocked').map((f) => f.label),
      лог: state.audit
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'decision-' + D.client.id + '-' + state.scenarioId + '.json';
    a.click();
    URL.revokeObjectURL(a.href);
    toast('Протокол решения выгружен', 'ok');
    log('экспорт', 'протокол решения выгружен в JSON');
    renderRisks();
  }

  /* ============================ старт ============================ */
  function boot() {
    D.init();
    TW.calibrate();
    bind();
    const restored = restoreClient();
    /* диплинки для показа: #tab, #tab/scenario, #tab/scenario/revealed | new */
    const h = (location.hash || '').replace(/^#/, '').split('/').filter(Boolean);
    const startScen = (h[1] && D.SCENARIOS.some((s) => s.id === h[1])) ? h[1] : 'full';
    setScenario(startScen, true);
    if (h[0] && document.getElementById('panel-' + h[0])) switchTab(h[0]);
    if (h[2] === 'revealed') reveal();
    if (h.indexOf('new') >= 0) openClient(D.client);
    log('старт', 'модель импутации инициализирована: ' + D.pop.length + ' клиентов в обучающей выборке');
    if (restored) log('клиент', 'восстановлен клиент ' + D.client.id + ' из localStorage');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();