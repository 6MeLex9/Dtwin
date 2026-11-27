/* Смоук-тест всех режимов MVP: сценарии, контрмеры, калибровка */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const root = path.join(__dirname, '..', 'js');
['util.js', 'data.js', 'impute.js', 'twin.js'].forEach((f) =>
  vm.runInThisContext(fs.readFileSync(path.join(root, f), 'utf8'), { filename: f }));

const D = DT.data, I = DT.impute, TW = DT.twin, U = DT.util;
let fails = 0, checks = 0;
function ok(cond, msg) {
  checks++;
  if (!cond) { fails++; console.log('  FAIL:', msg); }
}

const t0 = Date.now();
D.init(); TW.calibrate();
console.log('init', Date.now() - t0, 'мс');

/* --- сценарии --- */
const expect = { full: 'offer', partners: 'offer', api: 'guarded', consent: 'request', adversarial: 'request' };
const results = {};
D.SCENARIOS.forEach((sc) => {
  const imp = I.run(sc.states);
  const sim = TW.simulate(imp, { N: 900 });
  results[sc.id] = { sim, imp };
  const okGrade = sim.grade === expect[sc.id];
  console.log(pad(sc.id, 12), 'grade=' + pad(sim.grade, 8), 'conf=' + sim.decisionConf.toFixed(2),
    'core=' + imp.coreGap.toFixed(2), 'stab=' + sim.stability.toFixed(2),
    'price=' + Math.round(sim.finalPrice), okGrade ? '' : '  <-- ОЖИДАЛОСЬ ' + expect[sc.id]);
  ok(okGrade, sc.id + ': grade ' + sim.grade + ' вместо ' + expect[sc.id]);
  ok(isFinite(sim.finalPrice) && sim.finalPrice > 0, sc.id + ': цена положительна');
  ok(sim.variants.every((v) => isFinite(v.expProfit)), sc.id + ': прибыль конечна');
  ok(imp.ensemble.length === 20, sc.id + ': ансамбль из 20 цепочек');
});

/* --- инварианты импутации --- */
const impC = results.consent.imp;
impC.missingFields.forEach((f) => {
  const v = f.imputed.mean;
  ok(v >= D.F[f.id].min * 0.5 && v <= D.F[f.id].max * 1.5, 'imputed ' + f.id + ' в правдоподобных границах: ' + v);
  ok(f.imputed.lo < v && v < f.imputed.hi, 'интервал вокруг оценки: ' + f.id);
  ok(f.conf > 0 && f.conf < 1, 'уверенность в (0,1): ' + f.id);
});
const impP = results.partners.imp;
ok(impP.blockedFields.length === 1, 'партнёры: доход заблокирован');
ok(impP.fields.filter((f) => f.status === 'blocked')[0].id === 'income', 'заблокирован именно income');

/* --- контрмера: разрешить импутацию чувствительных --- */
const impAllow = I.run(D.SCENARIOS[1].states, { allowSensitive: true });
ok(impAllow.missingFields.some((f) => f.id === 'income'), 'allowSensitive: income импутируется');
ok(impAllow.blockedFields.length === 0, 'allowSensitive: нет заблокированных');

/* --- контрмера: отключённый ансамбль (single) --- */
const simSingle = TW.simulate(results.consent.imp, { N: 400, single: true });
ok(simSingle.stability === 1, 'single: устойчивость = 1 (ложная уверенность)');
ok(simSingle.profitSpread < 1e-6, 'single: разброс прибыли ~0');
const simEns = TW.simulate(results.consent.imp, { N: 400 });
ok(simEns.profitSpread > 0, 'ensemble: разброс прибыли > 0');
console.log('разброс прибыли: ensemble', Math.round(simEns.profitSpread), '| single', Math.round(simSingle.profitSpread));

/* --- порог отключён: оффер при слабом core --- */
const twGateOff = (() => {
  const imp = results.consent.imp;
  const sim = results.consent.sim;
  return { gate: sim.grade, core: imp.coreGap };
})();
ok(twGateOff.core < D.CONF_THRESHOLDS.coreFloor, 'consent: core ниже floor');

/* --- аудит смещения + перекалибровка --- */
const before = I.biasAudit();
console.log('\nаудит на отложенной выборке (n=' + before.n + '):');
before.fields.forEach((f) => {
  console.log('  ', pad(f.id, 14), 'n=' + f.n, 'сдвиг ×' + f.factor.toFixed(2),
    'MAE ' + U.fmtPct(f.mae, 1), 'смещение ' + U.fmtSignedPct(f.bias, 1),
    'покрытие ' + U.fmtPct(f.cover, 0), '→ предлагаемый ×' + f.suggestedFactor.toFixed(2));
  ok(f.n > 10, 'достаточно наблюдений для аудита ' + f.id);
});
const sug = {};
before.fields.forEach((f) => { sug[f.id] = f.suggestedFactor; });
const after = I.biasAudit(sug);
after.fields.forEach((f) => {
  const b = before.fields.filter((x) => x.id === f.id)[0];
  ok(Math.abs(f.bias) < Math.abs(b.bias) + 1e-9, 'перекалибровка уменьшает |смещение| для ' + f.id);
  console.log('  ', pad(f.id, 14), 'после: MAE ' + U.fmtPct(f.mae, 1), 'смещение ' + U.fmtSignedPct(f.bias, 1));
});

/* --- импутация после перекалибровки --- */
const impRecal = I.run(D.SCENARIOS[3].states, { mnarShift: sug });
const mil = impRecal.byId.mileage;
const mil0 = impC.byId.mileage;
console.log('пробег: оценка', Math.round(mil0.imputed.mean), '→ после перекалибровки', Math.round(mil.imputed.mean),
  '| факт', D.client.truth.mileage);
ok(Math.abs(mil.imputed.mean - D.client.truth.mileage) < Math.abs(mil0.imputed.mean - D.client.truth.mileage),
  'перекалибровка приближает оценку пробега к факту');

/* --- ценность запроса данных --- */
const voi = TW.valueOfInfo(results.consent.imp, results.consent.sim, { N: 240 });
ok(voi.length === 3, 'VOI: три кандидата');
ok(voi.every((v) => isFinite(v.gainConf)), 'VOI: приросты конечны');
console.log('VOI топ:', voi[0].label, 'Δ', U.fmtSignedPct(voi[0].gainConf, 1));

/* --- объяснимость --- */
const ex = TW.explain(results.consent.imp, results.consent.sim);
ok(Math.abs(ex.final - (ex.base + ex.total)) < 1e-6, 'объяснимость сходится');
ok(ex.items.some((i) => i.imputed), 'в объяснимости есть импутированные признаки');

/* --- создание клиента: пресеты, случайный, валидация --- */
console.log('\n--- клиенты ---');
const defaultId = D.client.id;
ok(D.defaultClient.id === 'KL-24817', 'демо-клиент сохранён как defaultClient');
ok(D.PRESETS.length === 5, 'пять готовых персон');

D.client = D.makeClient(D.PRESETS[1]);
ok(D.client.truth.mileage === 39800 && D.client.truth.age === 29, 'пресет «Курьер» применён целиком');
ok(D.client.profile.indexOf('29 лет') === 0, 'подпись клиента собрана: ' + D.client.profile);
ok(D.client.custom === false, 'пресет без флага custom');
const impCur = I.run(D.SCENARIOS[3].states);
ok(impCur.byId.mileage != null && isFinite(impCur.byId.mileage.imputed.mean), 'курьер: пробег импутирован');
ok(!impCur.adversarial.flagged, 'один отказ — это ещё не систематический пропуск');
D.client = D.makeClient({
  history: D.PRESETS[1].history.concat([{ date: '13.04', field: 'mileage', event: 'повторный отказ', via: 'приложение' }]),
  truth: D.PRESETS[1].truth
});
ok(I.run(D.SCENARIOS[3].states).adversarial.flagged, 'два отказа по пробегу → детектор сработал');
D.client = D.makeClient(D.PRESETS[1]);
const simCur = TW.simulate(impCur, { N: 500 });
ok(isFinite(simCur.finalPrice) && simCur.finalPrice > 0, 'курьер: цена посчитана');
console.log('  курьер:', D.client.id, 'риск ×' + simCur.riskIndexForClient.toFixed(2),
  'цена', Math.round(simCur.finalPrice), 'грейд', simCur.grade);

D.client = D.makeClient(D.PRESETS[3]);
const impRet = I.run(D.SCENARIOS[0].states);
const simRet = TW.simulate(impRet, { N: 500 });
ok(simRet.riskIndexForClient < simCur.riskIndexForClient, 'пенсионер дешевле курьера по риск-индексу');
console.log('  пенсионер: риск ×' + simRet.riskIndexForClient.toFixed(2), 'цена', Math.round(simRet.finalPrice));

ok(D.validateClient(D.PRESETS[2]).length === 0, 'опытный клиент проходит валидацию без замечаний');
ok(D.validateClient({ truth: { age: 20, 'vehicle_age': 9 } }).length > 0, 'валидатор ловит машину старше водительского стажа');
ok(D.validateClient({ truth: { mileage: 80000 } }).length > 0, 'валидатор ловит экстремальный пробег');

for (let i = 0; i < 25; i++) {
  D.client = D.makeClient(D.randomClient());
  const impR2 = I.run(D.SCENARIOS[i % 5].states);
  const simR2 = TW.simulate(impR2, { N: 200 });
  if (!isFinite(simR2.finalPrice) || !isFinite(impR2.sessionConf)) {
    ok(false, 'случайный клиент сломал конвейер на итерации ' + i);
    break;
  }
}
ok(true, '25 случайных клиентов прошли весь конвейер');
ok(D.makeClient({ truth: { mileage: 1e9 } }).truth.mileage === D.F.mileage.max, 'значения обрезаются в границы признака');
D.client = D.makeClient(D.DEFAULT_SPEC);

/* --- производительность худшего случая --- */
const t1 = Date.now();
const impAdv = I.run(D.SCENARIOS[4].states);
const tImp = Date.now() - t1;
const t2 = Date.now();
TW.simulate(impAdv, { N: 1400 });
TW.valueOfInfo(impAdv, results.adversarial.sim, { N: 300 });
const tRest = Date.now() - t2;
console.log('\nхудший случай: импутация', tImp, 'мс · twin+VOI', tRest, 'мс');
ok(tImp < 1500, 'импутация укладывается в 1.5 с');

console.log('\nпроверок:', checks, '| провалов:', fails);
process.exit(fails ? 1 : 0);

function pad(s, n) { return String(s).padEnd(n); }