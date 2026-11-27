/* ДТ-ИМПУТАЦИЯ · движок импутации: ridge-регрессия, MICE с бутстрэпом,
   типизированная пропущенность, политики MCAR/MAR/MNAR                          */
(function (global) {
  'use strict';
  const U = global.DT.util;
  const D = global.DT.data;

  const I = {};

  /* Политика по типу пропущенности: тип задаёт ШИРИНУ интервала и наличие сдвига приора.
     Уверенность больше не задаётся штрафной таблицей — она считается из распределения (см. ниже). */
  I.TYPE_SD_INFLATE = { MCAR: 1.00, MAR: 1.12, MNAR: 1.50 };
  /* допуск: в каких долях σ популяции (в шкале модели) значение считается «неискажённым».
     Уверенность = доля ансамбля внутри этого коридора, т.е. вероятность остаться в допуске. */
  I.TOL = { core: 0.60, middle: 0.75, weak: 1.00, sens: 0.60 };
  I.MNAR_CONF_DISCOUNT = 0.90;   // приор сдвига сам приблизительный
  I.ADV_CONF_DISCOUNT = 0.90;
  /* сдвиг приора при MNAR: скрывают те, у кого значение выше среднего */
  I.DEFAULT_MNAR_SHIFT = { mileage: 1.18, hard_braking: 1.12 };
  I.AXIS_CLIP = 3;

  /* ---------- трансформации ---------- */
  I.toModel = function (f, v) {
    if (v === null || v === undefined || !isFinite(v)) return NaN;
    return f.transform === 'log' ? Math.log(Math.max(v, 1e-6)) : v;
  };
  I.fromModel = function (f, z) {
    return f.transform === 'log' ? Math.exp(z) : z;
  };

  /* ---------- ridge ---------- */
  /**
   * X: n×p (сырые значения), y: n
   * Возвращает модель в стандартизованном пространстве + остаточное СКО в единицах y.
   */
  I.ridgeFit = function (X, y, lambda) {
    const n = X.length, p = X[0].length;
    const xm = new Array(p).fill(0), xs = new Array(p).fill(1);
    for (let j = 0; j < p; j++) {
      let s = 0;
      for (let i = 0; i < n; i++) s += X[i][j];
      const m = s / n;
      let ss = 0;
      for (let i = 0; i < n; i++) { const d = X[i][j] - m; ss += d * d; }
      xm[j] = m;
      xs[j] = ss > 1e-9 ? Math.sqrt(ss / (n - 1)) : 0; // 0 => колонка константна
    }
    let ys = 0;
    for (let i = 0; i < n; i++) ys += y[i];
    const ym = ys / n;
    let yss = 0;
    for (let i = 0; i < n; i++) { const d = y[i] - ym; yss += d * d; }
    const ysd = yss > 1e-9 ? Math.sqrt(yss / (n - 1)) : 0;

    const A = [], b = new Array(p).fill(0);
    for (let j = 0; j < p; j++) A.push(new Array(p).fill(0));
    for (let i = 0; i < n; i++) {
      const z = new Array(p);
      for (let j = 0; j < p; j++) z[j] = xs[j] > 0 ? (X[i][j] - xm[j]) / xs[j] : 0;
      const yc = y[i] - ym;
      for (let j = 0; j < p; j++) {
        const zj = z[j];
        if (zj === 0) continue;
        const row = A[j];
        for (let k = 0; k <= j; k++) row[k] += zj * z[k];
        b[j] += zj * yc;
      }
    }
    for (let j = 0; j < p; j++) for (let k = j + 1; k < p; k++) A[j][k] = A[k][j];
    for (let j = 0; j < p; j++) A[j][j] += lambda + 1e-9;

    // решение (Гаусс с выбором ведущего элемента)
    const M = A.map((r, i) => r.concat([b[i]]));
    for (let c = 0; c < p; c++) {
      let piv = c, best = Math.abs(M[c][c]);
      for (let r = c + 1; r < p; r++) {
        const v = Math.abs(M[r][c]);
        if (v > best) { best = v; piv = r; }
      }
      if (best < 1e-12) continue;
      if (piv !== c) { const t = M[c]; M[c] = M[piv]; M[piv] = t; }
      const d = M[c][c];
      for (let k = c; k <= p; k++) M[c][k] /= d;
      for (let r = 0; r < p; r++) {
        if (r === c) continue;
        const f = M[r][c];
        if (f === 0) continue;
        for (let k = c; k <= p; k++) M[r][k] -= f * M[c][k];
      }
    }
    const w = new Array(p);
    for (let j = 0; j < p; j++) w[j] = isFinite(M[j][p]) ? M[j][p] : 0;

    // остаточная дисперсия в единицах y
    let sse = 0;
    for (let i = 0; i < n; i++) {
      let yhat = 0;
      for (let j = 0; j < p; j++) {
        if (xs[j] === 0) continue;
        let z = (X[i][j] - xm[j]) / xs[j];
        if (z > I.AXIS_CLIP) z = I.AXIS_CLIP; else if (z < -I.AXIS_CLIP) z = -I.AXIS_CLIP;
        yhat += w[j] * z;
      }
      const res = (y[i] - ym) - yhat * ysd;
      sse += res * res;
    }
    const dof = Math.max(1, n - p - 1);
    return { w, xm, xs, ym, ysd, residSd: Math.sqrt(sse / dof), n, p };
  };

  I.ridgePredict = function (m, x) {
    let z = 0;
    for (let j = 0; j < m.p; j++) {
      if (m.xs[j] === 0) continue;
      let v = (x[j] - m.xm[j]) / m.xs[j];
      if (v > I.AXIS_CLIP) v = I.AXIS_CLIP; else if (v < -I.AXIS_CLIP) v = -I.AXIS_CLIP;
      z += m.w[j] * v;
    }
    return m.ym + z * m.ysd;
  };

  /* ---------- подготовка матрицы популяции ---------- */
  I.buildTrainingMatrix = function (rows, ids) {
    return rows.map((r) => ids.map((id) => I.toModel(D.F[id], r[id])));
  };

  /* ---------- уверенность как вероятность остаться в допуске ----------
     Допуск задан в долях σ популяции И В ШКАЛЕ МОДЕЛИ (для скошенных величин — в логарифмах).
     Это убирает несравнимость «км против процентов»: раньше σ пробега в километрах
     сравнивалась с σ популяции, а любое честное распределение логнормали давало σ/σ_pop > 1
     и уверенность падала в пол 0,1 независимо от клиента. */
  I.confidence = function (id, type, isAdv, sdModel) {
    const tol = I.TOL[D.F[id].role] || 0.75;
    const band = tol * D.popStats[id].sd;
    let conf = sdModel > 1e-9 ? 2 * U.normCdf(band / sdModel) - 1 : 1;
    if (type === 'MNAR') conf *= I.MNAR_CONF_DISCOUNT;
    else if (type === 'STALE') conf *= 0.95;
    if (isAdv) conf *= I.ADV_CONF_DISCOUNT;
    return U.clamp(conf, 0.02, 0.98);
  };

  /* коридор допуска в исходных единицах — для подписи в интерфейсе */
  I.toleranceBand = function (id, zMean) {
    const tol = I.TOL[D.F[id].role] || 0.75;
    const band = tol * D.popStats[id].sd;
    return {
      lo: I.fromModel(D.F[id], zMean - band),
      hi: I.fromModel(D.F[id], zMean + band),
      tol: tol
    };
  };

  /* ---------- основная функция: импутация профиля клиента ---------- */
  /**
   * client: объект с .truth (полные значения) и .history
   * states: {featureId: {status, type, reason, months}}
   * opts:   {B, iters, lambda, seed, mnarShift}
   */
  I.run = function (states, opts) {
    opts = opts || {};
    const B = opts.B || 20;
    const iters = opts.iters || 3;
    const lambda = opts.lambda === undefined ? 0.7 : opts.lambda;
    const rng = U.mulberry32(opts.seed || 424242);
    const shift = Object.assign({}, I.DEFAULT_MNAR_SHIFT, opts.mnarShift || {});
    const ids = D.FEATURE_IDS;
    const Xtrain = I.buildTrainingMatrix(D.pop, ids);
    const nTrain = Xtrain.length;
    const truth = D.client.truth;

    /* правдоподобные границы значений (0.5–99.5 перцентиль обучающей выборки):
       защита от экстраполяции ridge на «крайних» членах цепочки MICE */
    const bounds = ids.map((id, j) => {
      const col = Xtrain.map((r) => r[j]);
      return { lo: U.quantile(col, 0.005), hi: U.quantile(col, 0.995) };
    });
    I.bounds = bounds;

    /* --- карта статусов --- */
    const fields = ids.map((id) => {
      const f = D.F[id];
      const st = states[id] || { status: 'observed' };
      const status = st.status;
      return {
        id: id,
        label: f.label,
        short: f.short,
        unit: f.unit,
        layer: f.layer,
        pct: !!f.pct,
        d: f.d,
        sens: !!f.sens,
        status: status,
        type: status === 'missing' ? (st.type || 'MCAR') : (status === 'stale' ? 'STALE' : null),
        reason: st.reason || '',
        months: st.months || 0,
        observed: truth[id],
        imputed: null,
        conf: status === 'observed' ? 0.95 : null,
        corrected: false
      };
    });
    const byId = {};
    fields.forEach((f) => { byId[f.id] = f; });
    /* контроль «запрет импутации чувствительных» можно снять — тогда такие поля заполняются */
    if (opts.allowSensitive) {
      fields.forEach((f) => {
        if (f.status === 'blocked') {
          f.status = 'missing'; f.type = 'MAR';
          f.reason = 'контроль «запрет чувствительных» выключен — поле импортируется';
        }
      });
    }
    const missingFields = fields.filter((f) => f.status === 'missing');
    const staleFields = fields.filter((f) => f.status === 'stale');
    const blockedFields = fields.filter((f) => f.status === 'blocked');
    const sensitiveImputableMissing = missingFields.filter((f) => f.sens);
    // чувствительные признаки не импутируются, если контроль включён
    const imputable = missingFields.filter((f) => !f.sens || opts.allowSensitive);
    const blockedBySensitivity = opts.allowSensitive ? [] : missingFields.filter((f) => f.sens);
    blockedBySensitivity.forEach((f) => { f.status = 'blocked'; f.type = null; f.reason = 'чувствительный признак — импутация запрещена (только ручной запрос)'; });

    /* --- базовая точка: наблюдаемые значения, остальное — среднее популяции --- */
    const baseX = new Array(ids.length).fill(0);
    const imputeIdx = imputable.map((f) => ids.indexOf(f.id));
    ids.forEach((id, j) => {
      const f = byId[id];
      if (f.status === 'observed' || f.status === 'stale') baseX[j] = I.toModel(D.F[id], truth[id]);
      else baseX[j] = D.popStats[id].mean; // старт цепочки MICE
    });

    /* --- MICE: B бутстрэп-цепочек, каждая даёт один полный профиль --- */
    const ens = [];        // полные профили в модельном пространстве
    const noiseInfo = {};  // id -> residSd последней подгонки (для алеаторного шума)
    for (let b = 0; b < B; b++) {
      // бутстрэп-выборка популяции
      const idx = new Array(nTrain);
      for (let i = 0; i < nTrain; i++) idx[i] = Math.floor(rng() * nTrain);
      const Xb = idx.map((i) => Xtrain[i]);
      const x = baseX.slice();
      for (let it = 0; it < iters; it++) {
        for (let m = 0; m < imputeIdx.length; m++) {
          const j = imputeIdx[m];
          const ycol = Xb.map((row) => row[j]);
          const preds = [];
          for (let k = 0; k < ids.length; k++) if (k !== j) preds.push(k);
          const Xsub = Xb.map((row) => preds.map((k) => row[k]));
          const mdl = I.ridgeFit(Xsub, ycol, lambda);
          const xt = preds.map((k) => x[k]);
          x[j] = U.clamp(I.ridgePredict(mdl, xt), bounds[j].lo, bounds[j].hi);
          noiseInfo[ids[j]] = mdl.residSd;
        }
      }
      // алеаторный шум: распределение, а не точка
      const member = x.slice();
      for (let m = 0; m < imputeIdx.length; m++) {
        const j = imputeIdx[m];
        const f = byId[ids[j]];
        const inflate = I.TYPE_SD_INFLATE[f.type] || 1;
        member[j] = U.clamp(member[j] + U.randn(rng) * (noiseInfo[ids[j]] || 0) * inflate, bounds[j].lo, bounds[j].hi);
      }
      ens.push(member);
    }
    // разброс устаревших наблюдений: чем дольше не обновлялось, тем шире дрейф
    staleFields.forEach((f) => {
      const j = ids.indexOf(f.id);
      const drift = U.clamp(0.10 + 0.035 * (f.months || 0), 0.10, 0.50);
      const sdModel = D.popStats[f.id].sd * drift;
      f.drift = drift;
      ens.forEach((member) => { member[j] += U.randn(rng) * sdModel; });
    });

    /* --- детектор adversarial-пропусков: нужен ДО сдвига приора --- */
    const hist = D.client.history || [];
    const repeated = {};
    hist.forEach((h) => { repeated[h.field] = (repeated[h.field] || 0) + 1; });
    const advFields = Object.keys(repeated).filter((k) => repeated[k] >= 2 && states[k] && states[k].status === 'missing');

    /* --- сдвиг приора при MNAR + отчётность по каждому признаку --- */
    const report = {};
    imputable.forEach((f) => {
      const j = ids.indexOf(f.id);
      const isAdv = advFields.indexOf(f.id) >= 0;
      // значения в модельном пространстве до сдвига
      const raw = ens.map((m) => I.fromModel(D.F[f.id], m[j]));
      let factor = 1;
      if (f.type === 'MNAR') {
        factor = (shift[f.id] || 1.15) * (isAdv ? 1.10 : 1);
        f.corrected = true;
        for (let e = 0; e < ens.length; e++) {
          if (D.F[f.id].transform === 'log') ens[e][j] += Math.log(factor);
          else ens[e][j] *= factor;
          const span = bounds[j].hi - bounds[j].lo;
          ens[e][j] = U.clamp(ens[e][j], bounds[j].lo, bounds[j].hi + 0.75 * span);
        }
      }
      const vals = ens.map((m) => I.fromModel(D.F[f.id], m[j]));
      const mean = U.mean(vals);
      const sd = U.sd(vals);
      const lo = U.quantile(vals, 0.05), hi = U.quantile(vals, 0.95);
      const zSd = U.sd(ens.map((m) => m[j]));
      const conf = I.confidence(f.id, f.type, isAdv, zSd);
      const relSd = zSd / Math.max(D.popStats[f.id].sd, 1e-9);
      /* доля разброса признака, которую объясняют известные признаки (R² модели) */
      const r2 = U.clamp(1 - Math.pow((noiseInfo[f.id] || 0) / Math.max(D.popStats[f.id].sd, 1e-9), 2), 0, 1);
      f.imputed = {
        mean, sd, lo, hi, samples: U.sorted(vals), relSd, conf, r2,
        band: I.toleranceBand(f.id, U.mean(ens.map((m) => m[j]))),
        factor, uncorrectedMean: U.mean(raw)
      };
      f.conf = conf;
      f.method = 'MICE · ridge · 3 итерации · B=20' + (f.type === 'MNAR' ? ' + MNAR-сдвиг ×' + factor.toFixed(2) : '') + (isAdv ? ' (усилен)' : '');
      report[f.id] = f.imputed;
    });
    staleFields.forEach((f) => {
      const j = ids.indexOf(f.id);
      const vals = ens.map((m) => I.fromModel(D.F[f.id], m[j]));
      const zSd = U.sd(ens.map((m) => m[j]));
      const conf = I.confidence(f.id, 'STALE', false, zSd);
      f.imputed = {
        mean: U.mean(vals), sd: U.sd(vals), lo: U.quantile(vals, 0.05), hi: U.quantile(vals, 0.95),
        samples: U.sorted(vals), relSd: zSd / Math.max(D.popStats[f.id].sd, 1e-9),
        conf, band: I.toleranceBand(f.id, U.mean(ens.map((m) => m[j]))),
        factor: 1, uncorrectedMean: truth[f.id]
      };
      f.conf = conf;
      f.method = 'наблюдение устарело (' + f.months + ' мес.) · дрейф ' + Math.round((f.drift || 0) * 100) + '% σ';
    });
    blockedFields.forEach((f) => {
      f.method = 'импутация запрещена';
      f.conf = 0;
    });

    /* --- агрегированные метрики профиля ---
       уверенность профиля = взвешенное геометрическое среднее: это «вероятность, что весь
       профиль остался в допуске», если признаки считать независимыми */
    const used = fields.filter((f) => f.status === 'observed' || f.status === 'missing' || f.status === 'stale');
    const weights = { core: 1.0, middle: 0.6, weak: 0.25, sens: 0 };
    let wsum = 0, lnAcc = 0;
    used.forEach((f) => {
      const w = weights[D.F[f.id].role] || 0.3;
      const c = f.status === 'observed' ? 0.98 : f.conf;
      lnAcc += w * Math.log(Math.max(c, 0.02));
      wsum += w;
    });
    const confWeighted = wsum ? Math.exp(lnAcc / wsum) : 0;
    const observedShare = fields.filter((f) => f.status === 'observed').length / fields.length;
    const sessionConf = U.clamp(confWeighted * (0.80 + 0.20 * observedShare), 0.05, 0.97);

    /* --- детектор adversarial-пропусков --- */
    const adversarial = {
      flagged: advFields.length > 0,
      fields: advFields.map((id) => ({ id, label: D.F[id].label, count: repeated[id] })),
      score: U.clamp(advFields.length ? 0.35 + 0.18 * advFields.length : 0, 0, 1),
      note: advFields.length
        ? 'Повторные отказы по ' + advFields.map((id) => D.F[id].short.toLowerCase()).join(', ') + ' — сдвиг приора усилен на 10%, уверенность снижена'
        : 'Систематических отказов нет'
    };

    /* --- минимальная уверенность по ключевым (core) признакам --- */
    const CORE = ['age', 'vehicle_age', 'tenure', 'claims_3y', 'mileage'];
    const coreConf = fields.filter((f) => CORE.indexOf(f.id) >= 0).map((f) => {
      const c = f.status === 'observed' ? 1.0 :
        (f.status === 'stale' ? 0.55 : (f.status === 'blocked' ? 0 : (f.conf || 0)));
      return { id: f.id, label: f.label, conf: c, status: f.status, type: f.type };
    });
    coreConf.sort((a, b) => a.conf - b.conf);
    const coreGap = coreConf.length ? coreConf[0].conf : 1;

    return {
      fields, byId,
      missingFields: imputable, staleFields, blockedFields, blockedBySensitivity,
      sensitiveImputableMissing,
      ensemble: ens,          // B полных профилей в модельном пространстве
      ids,
      sessionConf,
      confWeighted,
      observedShare,
      coreConf, coreGap,
      adversarial,
      coverage: {
        total: fields.length,
        observed: fields.filter((f) => f.status === 'observed').length,
        missing: missingFields.length,
        stale: staleFields.length,
        blocked: fields.filter((f) => f.status === 'blocked').length
      },
      /* точечный профиль (апостериорные средние) — для тарифа и объяснимости */
      pointProfile: function () {
        const p = {};
        ids.forEach((id) => {
          const f = byId[id];
          if (f.status === 'observed') p[id] = truth[id];
          else if ((f.status === 'stale' || f.status === 'missing') && f.imputed) p[id] = f.imputed.mean;
          else p[id] = D.popStats[id].rawMean;
        });
        return p;
      },
      /* профиль в модельном пространстве, из которого симулятор берёт выборки */
      sampleProfile: function (r) {
        const e = ens[Math.floor(r * ens.length)];
        return e;
      }
    };
  };

  /* =========================================================
     Аудит смещения импутации на отложенной выборке + перекалибровка MNAR-сдвига
     ========================================================= */
  I.biasAudit = function (shiftOverride) {
    const shift = Object.assign({}, I.DEFAULT_MNAR_SHIFT, shiftOverride || {});
    const ids = D.FEATURE_IDS;
    const Xtrain = I.buildTrainingMatrix(D.pop, ids);
    const Xhold = I.buildTrainingMatrix(D.holdout, ids);
    const fields = [];
    const MNAR_FIELDS = ['mileage', 'hard_braking'];

    MNAR_FIELDS.forEach((id) => {
      const j = ids.indexOf(id);
      const preds = ids.map((x, k) => k).filter((k) => k !== j);
      const Xsub = Xtrain.map((r) => preds.map((k) => r[k]));
      const y = Xtrain.map((r) => r[j]);
      const mdl = I.ridgeFit(Xsub, y, 0.7);
      const cutoff = U.quantile(y, 0.55);       // MNAR-механизм: пропуск у «худших»
      const sigma = mdl.residSd;
      const factor = shift[id] || 1.15;
      let n = 0, absSum = 0, biasSum = 0, cover = 0, sumAct = 0, sumPred0 = 0;
      D.holdout.forEach((row, i) => {
        const yTrue = Xhold[i][j];
        if (yTrue <= cutoff) return;            // эти клиенты данные дали
        const xt = preds.map((k) => Xhold[i][k]);
        const pred0 = I.ridgePredict(mdl, xt);  // без сдвига
        const pred = pred0 + Math.log(factor);
        const actRaw = Math.exp(yTrue);
        const predRaw = Math.exp(pred);
        n++;
        absSum += Math.abs((predRaw - actRaw) / actRaw);
        biasSum += (predRaw - actRaw) / actRaw;
        const lo = Math.exp(pred - 1.645 * sigma), hi = Math.exp(pred + 1.645 * sigma);
        if (actRaw >= lo && actRaw <= hi) cover++;
        sumAct += actRaw;
        sumPred0 += Math.exp(pred0);
      });
      fields.push({
        id, type: 'MNAR', n, factor,
        mae: n ? absSum / n : 0,
        bias: n ? biasSum / n : 0,
        cover: n ? cover / n : 0,
        suggestedFactor: sumPred0 > 0 ? sumAct / sumPred0 : factor
      });
    });
    return { fields, n: D.holdout.length };
  };

  global.DT.impute = I;
})(typeof window !== 'undefined' ? window : globalThis);