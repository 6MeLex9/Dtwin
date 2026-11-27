/* ДТ-ИМПУТАЦИЯ · Digital Twin: Монте-Карло по распределению профиля,
   оценка вариантов договора, устойчивость решения, ценность запроса данных  */
(function (global) {
  'use strict';
  const U = global.DT.util;
  const D = global.DT.data;

  const TW = {};

  /* =========================================================
     Параметры модели поведения (показываются в UI)
     ========================================================= */
  TW.P = {
    exposureBase: 12000,          // базовый годовой пробег, км
    claimBase: 0.165,             // базовая частота обращений при exposure = 1
    mixSmall: 0.55,               // доля «мелких» случаев
    sevSmallMean: 22000, sevSmallSigma: 0.55,
    sevLargeMean: 165000, sevLargeSigma: 0.70,
    glassFreq: 0.085, glassMean: 24000,
    theftRate: 0.0038,            // угон/стихия: редкое событие, учитывается как ожидаемая стоимость
    carValue: 1800000,
    dsago: 900,
    adminRatio: 0.16,             // расходы на ведение дела
    acqCost: 2400,                // стоимость привлечения
    targetMargin: { econom: 0.04, standart: 0.10, premium: 0.15 },
    kappa: { mileage: 0.62, style: 0.24, region: 0.85, driver: 0.85, claims: 0.90, condition: 0.85, night: 0.85 },
    riskAversion: 1.58,           // ценность покрытия относительно E[ущерба]
    riskAversionSd: 0.26,
    buyScale: 6200
  };

  /* ---------- риск-множители тарифа ---------- */
  TW.riskMultipliers = function (p) {
    const K = TW.P.kappa;
    return {
      mileage: Math.pow(U.clamp(p.mileage, 1000, 90000) / 11000, 0.42 * K.mileage / 0.62),
      style: Math.pow(U.clamp(p.hard_braking, 0.2, 20) / 3.0, 0.20 * K.style / 0.24),
      region: Math.pow((0.60 + U.clamp(p.district_risk, 0, 1)) / 0.86, K.region),
      driver: Math.pow(1 + 0.10 * Math.pow((U.clamp(p.age, 18, 80) - 45) / 18, 2), K.driver),
      claims: Math.pow(1 + 0.15 * U.clamp(p.claims_3y, 0, 11), K.claims),
      condition: Math.pow(U.clamp(1 + 0.006 * (70 - U.clamp(p.vehicle_condition, 0, 100)), 0.85, 1.15), K.condition),
      night: Math.pow(1 + 0.22 * (U.clamp(p.night_share, 0, 1) - 0.28), K.night)
    };
  };

  TW.logProduct = function (p) {
    const m = TW.riskMultipliers(p);
    let s = 0;
    for (const k in m) s += Math.log(m[k]);
    return s;
  };

  TW.normLog = 0;
  TW.basePremiums = { econom: 0, standart: 0, premium: 0 };
  TW.riskIndex = function (r) { return Math.exp(TW.logProduct(r) - TW.normLog); };

  /* ---------- физика риска клиента (ожидаемые величины) ---------- */
  TW.lambdaOf = function (p) {
    const C = TW.P;
    const exposure = U.clamp(p.mileage / C.exposureBase, 0.25, 4.5);
    const style = U.clamp(p.hard_braking / 3, 0.45, 2.4);
    const night = 1 + 0.30 * (U.clamp(p.night_share, 0, 1) - 0.28);
    const driver = 1 + 0.12 * Math.pow((U.clamp(p.age, 18, 80) - 45) / 18, 2);
    const region = 0.62 + U.clamp(p.district_risk, 0, 1);
    const claimsHist = 1 + 0.22 * U.clamp(p.claims_3y, 0, 11);
    const cond = U.clamp(1 + 0.005 * (70 - U.clamp(p.vehicle_condition, 0, 100)), 0.75, 1.3);
    return {
      lambda: C.claimBase * Math.pow(exposure, 0.55) * Math.pow(style, 0.35) * night * driver * region * claimsHist * cond,
      cond: cond
    };
  };

  /* E[max(0, S - F)] для логнормального S со средним mean и сигмой sigma */
  function expExcess(mean, sigma, F) {
    if (F <= 0) return mean;
    const mu = Math.log(mean) - 0.5 * sigma * sigma;
    const lnF = Math.log(F);
    const d1 = (mu + sigma * sigma - lnF) / sigma;
    const d2 = (mu - lnF) / sigma;
    return mean * U.normCdf(d1) - F * U.normCdf(d2);
  }

  TW.expectedPaid = function (v, p) {
    const C = TW.P;
    const l = TW.lambdaOf(p);
    const small = C.sevSmallMean * l.cond, large = C.sevLargeMean * l.cond;
    const perEvent = C.mixSmall * expExcess(small, C.sevSmallSigma, v.franchise)
      + (1 - C.mixSmall) * expExcess(large, C.sevLargeSigma, v.franchise);
    let paid = l.lambda * perEvent;
    const sc = v.scope;
    if (sc.glass) paid += C.glassFreq * C.glassMean * l.cond;
    if (sc.theft) paid += C.carValue * C.theftRate * l.cond * (1 + 0.35 * U.clamp(p.district_risk, 0, 1));
    if (sc.dsago) paid += C.dsago;
    return paid;
  };

  /* ---------- калибровка базовых премий на «среднем» клиенте ---------- */
  TW.calibrate = function () {
    const ref = {};
    D.FEATURE_IDS.forEach((id) => { ref[id] = D.popStats[id].rawMean; });
    TW.normLog = U.mean(D.pop.map((r) => TW.logProduct(r)));

    const paidRef = {};
    D.VARIANTS.forEach((v) => {
      const paid = TW.expectedPaid(v, ref);
      paidRef[v.id] = paid;
      const m = TW.P.targetMargin[v.id] || 0.1;
      TW.basePremiums[v.id] = (paid * (1 + m) + TW.P.acqCost) / (1 - TW.P.adminRatio);
      v.premium = TW.basePremiums[v.id];
      v.paidRef = paid;
      v.marginRef = m;
    });
    const idx = D.pop.map((r) => TW.riskIndex(r));
    TW.riskIndexStats = { mean: U.mean(idx), sd: U.sd(idx), p5: U.quantile(idx, 0.05), p95: U.quantile(idx, 0.95) };
    TW.calibration = { paidRef, basePremiums: Object.assign({}, TW.basePremiums), riskIndexStats: TW.riskIndexStats, normLog: TW.normLog };
    return TW.calibration;
  };

  /* ---------- выборка профиля из ансамбля импутации ---------- */
  TW.makeSampler = function (imp, override, single) {
    const ids = imp.ids;
    const ens = imp.ensemble;
    if (single) {
      const pt = imp.pointProfile();
      return function () {
        const p = {};
        ids.forEach((id) => { p[id] = pt[id]; });
        return p;
      };
    }
    const perFeatSd = ids.map((id, j) => U.sd(ens.map((e) => e[j])));
    const jIdx = override ? ids.indexOf(override.id) : -1;
    return function (rng) {
      const e = ens[Math.floor(rng() * ens.length)];
      const p = {};
      for (let j = 0; j < ids.length; j++) {
        let z = e[j];
        if (j === jIdx) z = override.value;
        else if (perFeatSd[j] > 0) z += U.randn(rng) * perFeatSd[j] * 0.35;
        p[ids[j]] = global.DT.impute.fromModel(D.F[ids[j]], z);
      }
      return p;
    };
  };

  /* ---------- симуляция по всем вариантам договора ---------- */
  TW.simulate = function (imp, opts) {
    opts = opts || {};
    const N = opts.N || 1600;
    const seed = opts.seed || 991173;
    const rng = U.mulberry32(seed);
    const surcharge = opts.surcharge === undefined
      ? U.clamp((1 - imp.sessionConf) * 0.26, 0, 0.12)
      : opts.surcharge;
    const sample = TW.makeSampler(imp, opts.override, opts.single);
    const variants = D.VARIANTS.map((v) => Object.assign({}, v, { premium: TW.basePremiums[v.id] }));
    const V = variants.length;
    const acc = variants.map(() => ({ p: [], profit: [], paid: [], surplus: [], price: [] }));

    for (let d = 0; d < N; d++) {
      const p = sample(rng);
      const riskIndex = TW.riskIndex(p);
      /* склонность к риску и вкус — свойства клиента, а не броска: разброс решения
         должен отражать неопределённость профиля, а не шум потребителя */
      const kAv = TW.P.riskAversion;
      for (let i = 0; i < V; i++) {
        const v = variants[i];
        const price = v.premium * riskIndex * (1 + surcharge);
        const paid = TW.expectedPaid(v, p);
        const perks = 350 * (v.installments > 1 ? 1 : 0) + 420 * U.clamp(p.tenure / 3, 0, 1);
        const surplus = paid * kAv - price + perks;
        const buyP = U.sigmoid(surplus / TW.P.buyScale);
        const profit = price * (1 - TW.P.adminRatio) - TW.P.acqCost - paid;
        const a = acc[i];
        a.p.push(buyP); a.profit.push(profit); a.paid.push(paid); a.surplus.push(surplus); a.price.push(price);
      }
    }

    const out = variants.map((v, i) => {
      const a = acc[i];
      const expProfit = U.mean(a.profit.map((pr, k) => pr * a.p[k]));
      const sortedProfit = U.sorted(a.profit);
      return {
        id: v.id, name: v.name, premium: v.premium, franchise: v.franchise,
        installments: v.installments, cover: v.cover, desc: v.desc, scope: v.scope,
        price: U.mean(a.price),
        paid: U.mean(a.paid),
        surplus: U.mean(a.surplus),
        buyP: U.mean(a.p),
        expProfit: expProfit,
        profitMean: U.mean(a.profit),
        profitMedian: U.quantile(sortedProfit, 0.5),
        profitLo: U.quantile(sortedProfit, 0.1),
        profitHi: U.quantile(sortedProfit, 0.9),
        lossRatio: U.mean(a.paid) / Math.max(U.mean(a.price), 1),
        pNegative: a.profit.filter((x) => x < 0).length / a.profit.length,
        profitPerSale: expProfit / Math.max(U.mean(a.p), 1e-6),
        draws: a.profit, probs: a.p, prices: a.price
      };
    });

    /* устойчивость решения */
    const eligible = out.map((o, i) => (o.buyP >= 0.30 ? i : -1)).filter((i) => i >= 0);
    const pool = eligible.length ? eligible : out.map((o, k) => k);
    const winners = new Array(out.length).fill(0);
    for (let d = 0; d < N; d++) {
      let best = -1, bestVal = -Infinity;
      for (const i of pool) {
        const val = acc[i].p[d] * acc[i].profit[d];
        if (val > bestVal) { bestVal = val; best = i; }
      }
      if (best >= 0) winners[best]++;
    }
    const chosenIdx = winners.indexOf(Math.max.apply(null, winners));
    const stability = winners[chosenIdx] / N;
    const chosen = out[chosenIdx];

    const point = imp.pointProfile();
    const riskIndexForClient = TW.riskIndex(point);
    const finalPrice = chosen.premium * riskIndexForClient * (1 + surcharge);
    const decisionConf = 0.65 * imp.sessionConf + 0.35 * stability;
    const th = D.CONF_THRESHOLDS;
    /* гейт: 1) ключевой признак не может быть «предположением» 2) порог уверенности.
       opts.gate === false — контрмера выключена пользователем (демонстрация деградации) */
    const gateOn = opts.gate === undefined ? true : !!opts.gate;
    let grade, reason, reasonField = null;
    if (!gateOn) {
      grade = 'offer'; reason = 'gate-off';
    } else if (imp.coreGap < th.coreFloor) {
      grade = 'request';
      reason = 'core';
      reasonField = imp.coreConf[0];
    } else if (decisionConf >= th.offer) {
      grade = 'offer'; reason = 'ok';
    } else if (decisionConf >= th.guarded) {
      grade = 'guarded'; reason = 'conf';
    } else {
      grade = 'request'; reason = 'conf';
    }

    return {
      N, surcharge, stability, decisionConf, grade, reason, reasonField,
      chosen, chosenIdx, variants: out, winners, eligibleCount: pool.length,
      finalPrice, riskIndexForClient,
      priceWithoutSurcharge: chosen.premium * riskIndexForClient,
      th, seed,
      profitSpread: chosen.profitHi - chosen.profitLo
    };
  };

  /* цена, которая была бы при известных фактических данных (для обратной связи) */
  TW.priceIfTruth = function (sim) {
    const idx = TW.riskIndex(D.client.truth);
    return {
      riskIndex: idx,
      price: sim.chosen.premium * idx * (1 + sim.surcharge),
      paid: TW.expectedPaid(sim.chosen, D.client.truth),
      profit: sim.chosen.premium * idx * (1 + sim.surcharge) * (1 - TW.P.adminRatio) - TW.P.acqCost
        - TW.expectedPaid(sim.chosen, D.client.truth)
    };
  };

  /* ---------- ценность запроса данных (ablation по каждому пропуску) ---------- */
  TW.valueOfInfo = function (imp, base, opts) {
    opts = opts || {};
    const cands = imp.missingFields.filter((f) => !f.sens);
    const res = [];
    const qs = [0.2, 0.5, 0.8];
    cands.forEach((f) => {
      const j = imp.ids.indexOf(f.id);
      let stabAcc = 0;
      qs.forEach((q) => {
        const target = U.quantile(imp.ensemble.map((e) => e[j]), q);
        const r = TW.simulate(imp, {
          N: opts.N || 420, seed: 7711, override: { id: f.id, value: target }, surcharge: base.surcharge
        });
        stabAcc += r.stability;
      });
      const stab = stabAcc / qs.length;
      const confAfter = 0.56 * stab + 0.44 * Math.min(0.96, imp.sessionConf + (1 - imp.sessionConf) * 0.60);
      res.push({
        id: f.id, label: f.label, short: f.short, type: f.type,
        stabilityAfter: stab, confAfter,
        gainStability: stab - base.stability, gainConf: confAfter - base.decisionConf,
        intervalWidth: f.imputed ? (f.imputed.hi - f.imputed.lo) : 0,
        reach: f.imputed && f.imputed.lo > 0 ? (f.imputed.hi / f.imputed.lo - 1) : 0
      });
    });
    res.sort((a, b) => b.gainConf - a.gainConf);
    return res;
  };

  /* ---------- объяснимость: влияние признаков на цену ---------- */
  TW.explain = function (imp, sim) {
    const p = imp.pointProfile();
    const m = TW.riskMultipliers(p);
    const chosen = sim.chosen;
    const base = chosen.premium;
    const labels = {
      mileage: 'Пробег', style: 'Стиль вождения', region: 'Риск района', driver: 'Возраст водителя',
      claims: 'История обращений', condition: 'Состояние авто', night: 'Ночные поездки'
    };
    const featOf = {
      mileage: 'mileage', style: 'hard_braking', region: 'district_risk', driver: 'age',
      claims: 'claims_3y', condition: 'vehicle_condition', night: 'night_share'
    };
    const keys = Object.keys(m);
    const nF = keys.length;
    const logs = {};
    let totalLog = 0;
    keys.forEach((k) => { logs[k] = Math.log(m[k]); totalLog += logs[k]; });
    /* так же, как в тарифе: R = exp(Σ ln m − нормировка по популяции) */
    const R = Math.exp(totalLog - TW.normLog);
    const price = base * R * (1 + sim.surcharge);

    const items = keys.map((k) => {
      const f = imp.byId[featOf[k]];
      /* вклад фактора в риск-индекс (первый порядок), нормировка распределена по факторам */
      const delta = logs[k] - TW.normLog / nF;
      return {
        id: k, label: labels[k], value: base * (Math.exp(delta) - 1), feature: featOf[k],
        imputed: !!f && (f.status === 'missing' || f.status === 'stale'),
        featureLabel: f ? f.label : ''
      };
    });
    const surchargeItem = {
      id: 'uncertainty', label: 'Надбавка за неопределённость', value: price - base * R,
      imputed: false, feature: null, isSurcharge: true, pct: sim.surcharge
    };
    items.push(surchargeItem);
    items.sort((a, b) => Math.abs(b.value) - Math.abs(a.value));

    const allAbs = items.reduce((s, i) => s + Math.abs(i.value), 0) || 1;
    const impAbs = items.filter((i) => i.imputed).reduce((s, i) => s + Math.abs(i.value), 0);
    return {
      base, items, price, riskIndex: R, impShare: impAbs / allAbs,
      total: price - base,
      final: price
    };
  };

  global.DT.twin = TW;
})(typeof window !== 'undefined' ? window : globalThis);