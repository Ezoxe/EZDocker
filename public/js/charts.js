import { raw, esc, fmtNumber } from './ui.js';

let uid = 0;

/** Small area chart for cards. */
export function sparkline(values, { width = 300, height = 52, color = '#818cf8' } = {}) {
  const id = `sg${++uid}`;
  const max = Math.max(1, ...values);
  const n = values.length;
  if (!n) return raw('');
  const step = n > 1 ? width / (n - 1) : width;
  const pts = values.map((v, i) => [i * step, height - 4 - (v / max) * (height - 10)]);
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1];
    const [x1, y1] = pts[i];
    const cx = (x0 + x1) / 2;
    d += ` C${cx},${y0} ${cx},${y1} ${x1},${y1}`;
  }
  const area = `${d} L${width},${height} L0,${height} Z`;
  return raw(`<svg class="sparkline" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" width="100%" height="100%">
    <defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${color}" stop-opacity=".35"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></linearGradient></defs>
    <path class="area" d="${area}" fill="url(#${id})"/>
    <path class="line" d="${d}" fill="none" stroke="${color}" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linecap="round"/>
  </svg>`);
}

function niceMax(v) {
  if (v <= 5) return 5;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const f = v / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
}

/**
 * Bar chart with optional stacked "error" part and optional line overlay.
 * bars: [{ value, error?, label, tooltip }], line: number[] (same length) or null.
 */
export function barChart(bars, { line = null, color = 'url(#barGrad)', errorColor = '#ef4444', lineColor = '#22d3ee', format = fmtNumber, labelEvery = 1 } = {}) {
  const W = 600;
  const H = 220;
  const pad = { l: 38, r: 8, t: 12, b: 26 };
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;
  const max = niceMax(Math.max(1, ...bars.map((b) => b.value)));
  // The line has its own scale (e.g. visitors vs requests) so it stays readable.
  const lineMax = Math.max(1, ...(line || [])) / 0.85;
  const slot = iw / Math.max(1, bars.length);
  const bw = Math.max(3, Math.min(34, slot * 0.62));
  const y = (v) => pad.t + ih - (v / max) * ih;
  const ly = (v) => pad.t + ih - (v / lineMax) * ih;

  let out = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img">
    <defs><linearGradient id="barGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#818cf8"/><stop offset="1" stop-color="#6366f1" stop-opacity=".55"/></linearGradient></defs>`;
  for (let i = 0; i <= 4; i++) {
    const v = (max / 4) * i;
    const yy = y(v);
    out += `<line class="grid-line" x1="${pad.l}" x2="${W - pad.r}" y1="${yy}" y2="${yy}"/>`;
    out += `<text x="${pad.l - 8}" y="${yy + 3}" text-anchor="end">${esc(format(v))}</text>`;
  }
  bars.forEach((b, i) => {
    const x = pad.l + slot * i + (slot - bw) / 2;
    const h = Math.max(b.value > 0 ? 2 : 0, (b.value / max) * ih);
    const eh = b.error ? Math.max(2, (b.error / max) * ih) : 0;
    out += `<g style="--i:${i}"><title>${esc(b.tooltip || `${b.label} : ${format(b.value)}`)}</title>`;
    out += `<rect class="bar" style="--i:${i}" x="${x}" y="${pad.t + ih - h}" width="${bw}" height="${h}" rx="${Math.min(4, bw / 3)}" fill="${color}"/>`;
    if (eh) out += `<rect class="bar" style="--i:${i}" x="${x}" y="${pad.t + ih - eh}" width="${bw}" height="${eh}" rx="2" fill="${errorColor}"/>`;
    out += `<rect x="${pad.l + slot * i}" y="${pad.t}" width="${slot}" height="${ih}" fill="transparent"/></g>`;
    if (i % labelEvery === 0) out += `<text x="${x + bw / 2}" y="${H - 8}" text-anchor="middle">${esc(b.label)}</text>`;
  });
  if (line && line.length) {
    const pts = line.map((v, i) => `${pad.l + slot * i + slot / 2},${ly(v)}`);
    out += `<polyline points="${pts.join(' ')}" fill="none" stroke="${lineColor}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round" class="spark-line"/>`;
    line.forEach((v, i) => {
      out += `<circle cx="${pad.l + slot * i + slot / 2}" cy="${ly(v)}" r="3.5" fill="#0b0f1a" stroke="${lineColor}" stroke-width="2"><title>${esc(fmtNumber(v))}</title></circle>`;
    });
  }
  out += '</svg>';
  return raw(out);
}

/** Horizontal distribution bar of HTTP status classes. */
export function statusBar(codes) {
  const total = Object.values(codes).reduce((a, b) => a + b, 0);
  const colors = { '2xx': '#22c55e', '3xx': '#60a5fa', '4xx': '#f59e0b', '5xx': '#ef4444' };
  const parts = Object.entries(codes)
    .filter(([, v]) => v > 0)
    .map(([k, v]) => `<span style="width:${(v / total) * 100}%;background:${colors[k]}" title="${k} : ${fmtNumber(v)}"></span>`)
    .join('');
  const legend = Object.entries(codes)
    .map(([k, v]) => `<span><i style="background:${colors[k]}"></i>${k} · ${fmtNumber(v)}</span>`)
    .join('');
  return raw(`<div class="codes">${parts}</div><div class="legend">${legend}</div>`);
}
