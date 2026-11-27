/* Проверка численной логики MVP без браузера: node tools/harness.cjs [--verbose] */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..', 'js');
['util.js', 'data.js', 'impute.js', 'twin.js'].forEach((f) => {
  vm.runInThisContext(fs.readFileSync(path.join(root, f), 'utf8'), { filename: f });
});

const U = globalThis.DT.util;
const D = globalThis.DT.data;
const I = globalThis.DT.impute;
const TW = globalThis.DT.twin;

const t0 = Date.now();
D.init();
const tInit = Date.now() - t0;
const cal = TW.calibrate();
const tCal = Date.now() - t0 - tInit;

const pad = (s, n) => String(s).padEnd(n);
const num = (x, d) => (isFinite(x) ? x.toFixed(d === undefined ? 0 : d) : '—');

console.log('=== ДАННЫЕ ===');
console.log('популяция:', D.pop.length, '| holdout:', D.holdout.length, '| init', tInit, 'мс | калибровка', tCal, 'мс');
console.log('риск-индекс по популяции: mean', num(cal.mean, 2), 'sd', num(cal.sd, 2), 'p5', num(cal.p5, 2), 'p95', num(cal.p95, 2));
console.log('Средние по популяции:');
['mileage', 'hard_braking', 'district_risk', 'vehicle_condition', 'credit_score', 'age'].forEach((id) => {
  const c = D.pop.map((r) => r[id]);
  console.log('  ', pad(id, 18), 'mean', num(U.mean(c), 1), 'sd', num(U.sd(c), 1));
});

let fails = 0;
D.SCENARIOS.forEach((sc) => {
  const t1 = Date.now();
  const imp = I.run(sc.states);
  const tImp = Date.now() - t1;
  const t2 = Date.now();
  const sim = TW.simulate(imp, { N: 1400 });
  const tSim = Date.now() - t2;

  console.log('\n================ ' + sc.title + ' (' + sc.id + ') ================');
  console.log('покрытие: observed', imp.coverage.observed, '/', imp.coverage.total,
    '| missing', imp.coverage.missing, '| stale', imp.coverage.stale, '| blocked', imp.coverage.blocked);
  console.log('sessionConf', num(imp.sessionConf, 3), '| импутация', tImp, 'мс | симуляция', tSim, 'мс');
  if (opt_verbose()) {
    imp.missingFields.concat(imp.staleFields).forEach((f) => {
      console.log('  ', pad(f.label, 24), pad(f.type || '', 5), 'mean', num(f.imputed.mean, f.d),
        'CI', num(f.imputed.lo, f.d) + '–' + num(f.imputed.hi, f.d),
        'conf', num(f.conf, 2), 'факт', num(D.client.truth[f.id], f.d));
    });
  }
  console.log('  сурчардж', num(sim.surcharge * 100, 1) + '%', '| риск-индекс', num(sim.riskIndexForClient, 2),
    '| финальная цена', num(sim.finalPrice));
  sim.variants.forEach((v) => {
    console.log('  ', pad(v.name, 10), 'цена', pad(num(v.price), 7), 'E[выплата]', pad(num(v.paid), 7),
      'убыт.', num(v.lossRatio, 2), 'P(куп)', num(v.buyP, 2), 'E[прибыль]', pad(num(v.expProfit), 7),
      'медиана', pad(num(v.profitMedian), 6), 'P(убыток)', num(v.pNegative, 2));
  });
  console.log('  ВЫБОР:', sim.chosen.name, '| устойчивость', num(sim.stability, 3),
    '| decisionConf', num(sim.decisionConf, 3), '| grade', sim.grade, '| winners', sim.winners.join('/'));
  if (opt_verbose()) {
    const vo = TW.valueOfInfo(imp, sim, { N: 300 });
    vo.slice(0, 4).forEach((v) => console.log('    запрос', pad(v.label, 24), 'стабильность', num(v.stabilityAfter, 3), 'Δ', num(v.gainStability, 3)));
    const ex = TW.explain(imp, sim);
    console.log('    цена из множителей:', num(ex.final), 'база', ex.base);
    ex.items.forEach((i) => console.log('      ', pad(i.label, 28), num(i.value), i.imputed ? '(импут.)' : ''));
  }
  // проверки-инварианты
  if (imp.sessionConf < 0 || imp.sessionConf > 1) { console.log('  !! sessionConf вне [0,1]'); fails++; }
  if (!isFinite(sim.chosen.expProfit)) { console.log('  !! expProfit не число'); fails++; }
  if (!['offer', 'guarded', 'request'].includes(sim.grade)) { console.log('  !! grade неизвестен'); fails++; }
});

function opt_verbose() { return process.argv.includes('--verbose'); }

console.log('\n=== АУДИТ/ОБРАТНАЯ СВЯЗЬ ===');
console.log('ошибки импутации по сценарию consent:');
const impC = I.run(D.SCENARIOS[3].states);
impC.missingFields.forEach((f) => {
  const act = D.client.truth[f.id];
  const inCI = act >= f.imputed.lo && act <= f.imputed.hi;
  console.log('  ', pad(f.label, 24), 'оценка', num(f.imputed.mean, f.d), 'факт', num(act, f.d),
    'ошибка', num(((f.imputed.mean - act) / act) * 100, 1) + '%', 'в 90% ДИ:', inCI ? 'да' : 'НЕТ');
});

console.log('\nвсего', Date.now() - t0, 'мс | провалов инвариантов:', fails);