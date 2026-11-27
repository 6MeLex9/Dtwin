/* ДТ-ИМПУТАЦИЯ · SVG-графика без внешних библиотек */
(function (global) {
  'use strict';
  const U = global.DT.util;
  const C = {};

  const svg = (w, h, inner, extra) =>
    '<svg viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="xMidYMid meet" class="ch-svg" ' + (extra || '') + '>' + inner + '</svg>';

  /* ---------- гистограмма ---------- */
  C.hist = function (samples, o) {
    o = o || {};
    const w = o.w || 560, h = o.h || 150, pad = { l: 8, r: 8, t: 10, b: 20 };
    const bins = o.bins || 26;
    if (!samples.length) return '<div class="ch-empty">нет данных</div>';
    const min = Math.min.apply(null, samples), max = Math.max.apply(null, samples);
    let lo = min, hi = max;
    if (o.zero && lo > 0) lo = 0;
    if (o.zero && hi < 0) hi = 0;
    const span = (hi - lo) || 1;
    const cnt = new Array(bins).fill(0);
    samples.forEach((v) => {
      let k = Math.floor(((v - lo) / span) * bins);
      if (k < 0) k = 0; if (k >= bins) k = bins - 1;
      cnt[k]++;
    });
    const cmax = Math.max.apply(null, cnt) || 1;
    const W = w - pad.l - pad.r, H = h - pad.t - pad.b;
    let inner = '';
    const bw = W / bins;
    for (let i = 0; i < bins; i++) {
      const bh = (cnt[i] / cmax) * H;
      inner += '<rect x="' + (pad.l + i * bw + 0.6).toFixed(1) + '" y="' + (pad.t + H - bh).toFixed(1) +
        '" width="' + Math.max(bw - 1.2, 1).toFixed(1) + '" height="' + bh.toFixed(1) + '" fill="' + (o.fill || '#3fd8c4') + '" opacity="0.85" rx="1"/>';
    }
    // нулевая линия
    if (lo <= 0 && hi >= 0) {
      const x = pad.l + ((0 - lo) / span) * W;
      inner += '<line x1="' + x.toFixed(1) + '" y1="' + pad.t + '" x2="' + x.toFixed(1) + '" y2="' + (pad.t + H) + '" stroke="#ff7b7b" stroke-width="1.2" stroke-dasharray="3 3"/>';
      inner += '<text x="' + (x + 4).toFixed(1) + '" y="' + (pad.t + 10) + '" fill="#ff9a9a" font-size="9">0</text>';
    }
    // маркеры p10/p90/mean
    (o.marks || []).forEach((m) => {
      if (!isFinite(m.x) || m.x < lo || m.x > hi) return;
      const x = pad.l + ((m.x - lo) / span) * W;
      inner += '<line x1="' + x.toFixed(1) + '" y1="' + (pad.t - 2) + '" x2="' + x.toFixed(1) + '" y2="' + (pad.t + H) + '" stroke="' + (m.color || '#eaeef7') + '" stroke-width="1" opacity="0.8" stroke-dasharray="2 2"/>';
      if (m.label) inner += '<text x="' + x.toFixed(1) + '" y="' + (h - 6) + '" fill="' + (m.color || '#93a3bd') + '" font-size="9" text-anchor="middle">' + U.esc(m.label) + '</text>';
    });
    // подписи оси
    inner += '<text x="' + pad.l + '" y="' + (h - 6) + '" fill="#6f7f99" font-size="9">' + U.esc(o.fmt ? o.fmt(lo) : lo) + '</text>';
    inner += '<text x="' + (w - pad.r) + '" y="' + (h - 6) + '" fill="#6f7f99" font-size="9" text-anchor="end">' + U.esc(o.fmt ? o.fmt(hi) : hi) + '</text>';
    return svg(w, h, inner);
  };

  /* ---------- полоса неопределённости (интервал + точка) ---------- */
  C.strip = function (o) {
    const w = o.w || 300, h = o.h || 26;
    const pad = 6, W = w - pad * 2;
    const lo = o.min !== undefined ? o.min : o.lo;
    const hi = o.hi;
    const span = (hi - lo) || 1;
    const X = (v) => pad + U.clamp((v - lo) / span, 0, 1) * W;
    const y = h / 2;
    let inner = '';
    // коридор допуска — внутри него значение считается «неискажённым»
    if (o.tolLo !== undefined && o.tolHi !== undefined) {
      inner += '<rect x="' + X(o.tolLo).toFixed(1) + '" y="2" width="' + Math.max(X(o.tolHi) - X(o.tolLo), 1).toFixed(1) +
        '" height="' + (h - 4) + '" fill="#3fd8c4" opacity="0.10" rx="2"/>';
      inner += '<line x1="' + X(o.tolLo).toFixed(1) + '" y1="2" x2="' + X(o.tolLo).toFixed(1) + '" y2="' + (h - 2) + '" stroke="#3fd8c4" stroke-width="1" opacity="0.35" stroke-dasharray="2 3"/>';
      inner += '<line x1="' + X(o.tolHi).toFixed(1) + '" y1="2" x2="' + X(o.tolHi).toFixed(1) + '" y2="' + (h - 2) + '" stroke="#3fd8c4" stroke-width="1" opacity="0.35" stroke-dasharray="2 3"/>';
    }
    // фон популяции
    if (o.popLo !== undefined) {
      inner += '<rect x="' + X(o.popLo).toFixed(1) + '" y="' + (y - 7) + '" width="' + Math.max(X(o.popHi) - X(o.popLo), 1).toFixed(1) +
        '" height="14" fill="#26334d" opacity="0.6" rx="2"/>';
    }
    // интервал
    inner += '<rect x="' + X(o.ciLo).toFixed(1) + '" y="' + (y - 4) + '" width="' + Math.max(X(o.ciHi) - X(o.ciLo), 1.5).toFixed(1) +
      '" height="8" fill="' + (o.color || '#f2b33d') + '" opacity="0.35" rx="2"/>';
    inner += '<line x1="' + X(o.ciLo).toFixed(1) + '" y1="' + (y - 8) + '" x2="' + X(o.ciLo).toFixed(1) + '" y2="' + (y + 8) + '" stroke="' + (o.color || '#f2b33d') + '" stroke-width="1.4"/>';
    inner += '<line x1="' + X(o.ciHi).toFixed(1) + '" y1="' + (y - 8) + '" x2="' + X(o.ciHi).toFixed(1) + '" y2="' + (y + 8) + '" stroke="' + (o.color || '#f2b33d') + '" stroke-width="1.4"/>';
    // среднее
    if (o.mean !== undefined) {
      inner += '<circle cx="' + X(o.mean).toFixed(1) + '" cy="' + y + '" r="3.4" fill="' + (o.color || '#f2b33d') + '" stroke="#0b1120" stroke-width="1"/>';
    }
    // факт (после раскрытия)
    if (o.actual !== undefined && isFinite(o.actual)) {
      inner += '<path d="M' + (X(o.actual) - 4).toFixed(1) + ' ' + (y - 7) + ' L' + (X(o.actual) + 4).toFixed(1) + ' ' + (y - 7) + ' L' + X(o.actual).toFixed(1) + ' ' + (y - 1) + ' Z" fill="#4ade80"/>';
    }
    return svg(w, h, inner);
  };

  /* ---------- вклад признаков (двусторонние бары) ---------- */
  C.contrib = function (items, o) {
    o = o || {};
    const rowH = 26, w = o.w || 520, h = items.length * rowH + 8;
    const labelW = o.labelW || 190, valW = 92;
    const plotW = w - labelW - valW - 10;
    const maxAbs = Math.max.apply(null, items.map((i) => Math.abs(i.value)).concat([1]));
    const cx = labelW + plotW / 2;
    let inner = '';
    items.forEach((it, i) => {
      const y = i * rowH + 6;
      const len = (Math.abs(it.value) / maxAbs) * (plotW / 2 - 4);
      const x = it.value >= 0 ? cx : cx - len;
      const color = it.isSurcharge ? '#f2b33d' : (it.imputed ? '#8f7bff' : (it.value >= 0 ? '#ff8878' : '#3fd8c4'));
      inner += '<text x="0" y="' + (y + rowH / 2 + 3) + '" fill="' + (it.imputed ? '#b9a8ff' : '#9fb0c9') + '" font-size="10.5">' +
        U.esc(it.label) + (it.imputed ? ' ·' : '') + '</text>';
      inner += '<rect x="' + x.toFixed(1) + '" y="' + (y + 3) + '" width="' + Math.max(len, 1).toFixed(1) + '" height="12" rx="2" fill="' + color + '" opacity="0.9"/>';
      inner += '<text x="' + (w - valW + 6) + '" y="' + (y + rowH / 2 + 3) + '" fill="' + (it.isSurcharge ? '#f2b33d' : '#dbe4f2') + '" font-size="10.5" text-anchor="end">' +
        U.fmtSigned(it.value) + ' ₽</text>';
    });
    inner += '<line x1="' + cx + '" y1="2" x2="' + cx + '" y2="' + (h - 6) + '" stroke="#2b3a56" stroke-width="1"/>';
    return svg(w, h, inner);
  };

  /* ---------- дуга уверенности с порогами ---------- */
  C.gauge = function (v, o) {
    o = o || {};
    const w = o.w || 150, h = o.h || 88, cx = w / 2, cy = h - 12, r = 52;
    const a0 = Math.PI, a1 = 0;
    const pt = (ang, rr) => [cx + Math.cos(ang) * rr, cy + Math.sin(ang) * rr * -1];
    const arc = (from, to, rr, color, op, width) => {
      const A = pt(a0 + (a1 - a0) * from, rr), B = pt(a0 + (a1 - a0) * to, rr);
      const large = (to - from) > 0.5 ? 1 : 0;
      return '<path d="M' + A[0].toFixed(1) + ' ' + A[1].toFixed(1) + ' A' + rr + ' ' + rr + ' 0 ' + large + ' 1 ' +
        B[0].toFixed(1) + ' ' + B[1].toFixed(1) + '" stroke="' + color + '" stroke-width="' + width + '" fill="none" stroke-linecap="round" opacity="' + op + '"/>';
    };
    const color = v >= (o.offer || 0.78) ? '#3fd8c4' : (v >= (o.guarded || 0.6) ? '#f2b33d' : '#ff7b7b');
    let inner = arc(0, 1, r, '#22304a', 1, 8);
    inner += arc(0, U.clamp(v, 0.001, 0.999), r, color, 1, 8);
    (o.ticks || []).forEach((t) => {
      const A = pt(a0 + (a1 - a0) * t, r - 11), B = pt(a0 + (a1 - a0) * t, r - 5);
      inner += '<line x1="' + A[0].toFixed(1) + '" y1="' + A[1].toFixed(1) + '" x2="' + B[0].toFixed(1) + '" y2="' + B[1].toFixed(1) + '" stroke="#5d7096" stroke-width="1"/>';
    });
    inner += '<text x="' + cx + '" y="' + (cy - 12) + '" fill="' + color + '" font-size="21" font-weight="600" text-anchor="middle">' + U.fmtPct(v, 0) + '</text>';
    if (o.label) inner += '<text x="' + cx + '" y="' + (cy + 4) + '" fill="#7f90ab" font-size="9" text-anchor="middle">' + U.esc(o.label) + '</text>';
    return svg(w, h, inner);
  };

  /* ---------- мини-бар (доля) ---------- */
  C.bar = function (v, o) {
    o = o || {};
    const h = o.h || 6;
    const color = o.color || (v >= 0.7 ? '#3fd8c4' : v >= 0.45 ? '#f2b33d' : '#ff7b7b');
    return '<div class="ch-mini" style="height:' + h + 'px"><span style="width:' + U.clamp(v, 0, 1) * 100 + '%;background:' + color + '"></span></div>';
  };

  /* ---------- стек (доли статусов) ---------- */
  C.stack = function (parts, o) {
    o = o || {};
    const total = parts.reduce((s, p) => s + p.value, 0) || 1;
    const segs = parts.map((p) =>
      '<span class="seg" style="width:' + (p.value / total) * 100 + '%;background:' + p.color + '" title="' + U.esc(p.label + ': ' + p.value) + '"></span>'
    ).join('');
    return '<div class="ch-stack" style="height:' + (o.h || 10) + 'px">' + segs + '</div>';
  };

  global.DT.charts = C;
})(typeof window !== 'undefined' ? window : globalThis);