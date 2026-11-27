/* ДТ-ИМПУТАЦИЯ · утилиты: ГПСЧ, статистика, форматирование */
(function (global) {
  'use strict';
  const U = {};

  /* ---------- RNG ---------- */
  U.mulberry32 = function (seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };
  U.randn = function (rng) {
    let u = 0, v = 0;
    while (u === 0) u = rng();
    while (v === 0) v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  U.lognormal = function (rng, meanLog, sdLog) {
    return Math.exp(meanLog + sdLog * U.randn(rng));
  };
  U.pick = function (rng, arr) { return arr[Math.floor(rng() * arr.length)]; };

  /* ---------- stats ---------- */
  U.mean = function (a) {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += a[i];
    return s / a.length;
  };
  U.variance = function (a) {
    if (a.length < 2) return 0;
    const m = U.mean(a);
    let s = 0;
    for (let i = 0; i < a.length; i++) s += (a[i] - m) * (a[i] - m);
    return s / (a.length - 1);
  };
  U.sd = function (a) { return Math.sqrt(U.variance(a)); };
  U.sorted = function (a) { return a.slice().sort((x, y) => x - y); };
  U.quantile = function (a, p) {
    if (!a.length) return NaN;
    const s = U.sorted(a);
    const h = (s.length - 1) * p;
    const lo = Math.floor(h), hi = Math.ceil(h);
    return s[lo] + (s[hi] - s[lo]) * (h - lo);
  };
  U.corr = function (a, b) {
    const n = Math.min(a.length, b.length);
    const ma = U.mean(a.slice(0, n)), mb = U.mean(b.slice(0, n));
    let num = 0, da = 0, db = 0;
    for (let i = 0; i < n; i++) {
      const x = a[i] - ma, y = b[i] - mb;
      num += x * y; da += x * x; db += y * y;
    }
    return da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0;
  };
  U.weightedMean = function (vals, ws) {
    let s = 0, w = 0;
    for (let i = 0; i < vals.length; i++) { s += vals[i] * ws[i]; w += ws[i]; }
    return w ? s / w : 0;
  };

  /* ---------- misc ---------- */
  U.clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
  U.lerp = (a, b, t) => a + (b - a) * t;
  U.sigmoid = (x) => 1 / (1 + Math.exp(-x));

  /* стандартная нормальная функция распределения (A&S 26.2.17) */
  U.normCdf = function (x) {
    const t = 1 / (1 + 0.2316419 * Math.abs(x));
    const d = 0.3989423 * Math.exp(-x * x / 2);
    const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
    return x > 0 ? 1 - p : p;
  };

  /* ---------- format ---------- */
  const nf = (x, d) => {
    if (!isFinite(x)) return '—';
    return x.toLocaleString('ru-RU', { minimumFractionDigits: d, maximumFractionDigits: d });
  };
  U.fmtNum = (x, d) => nf(x, d === undefined ? 0 : d);
  U.fmtPct = (x, d) => nf(x * 100, d === undefined ? 0 : d) + '%';
  U.fmtMoney = (x, d) => nf(x, d === undefined ? 0 : d) + ' ₽';
  U.fmtKm = (x) => nf(x, 0) + ' км';
  U.fmtSigned = (x, d) => (x > 0 ? '+' : '') + nf(x, d === undefined ? 0 : d);
  U.fmtSignedPct = (x, d) => (x > 0 ? '+' : '') + nf(x * 100, d === undefined ? 0 : d) + ' п.п.';
  U.fmtDec = (x, d) => nf(x, d === undefined ? 2 : d);

  U.esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  global.DT = global.DT || {};
  global.DT.util = U;
})(typeof window !== 'undefined' ? window : globalThis);