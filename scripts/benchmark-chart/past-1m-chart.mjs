#!/usr/bin/env node
// Past-the-context-window benchmark chart for the README (and memtree.dev).
//
// Edit the numbers below, then run:
//   node scripts/benchmark-chart/past-1m-chart.mjs
// It writes docs/images/benchmark-past-1m.{svg,png} (MemTree vs /compact past 1M)
// and docs/images/benchmark-past-1m-with-800k.{svg,png} (plus the 800k three-arm panel).
// PNGs are rendered at 2x by headless Chrome (set CHROME to override its path); pass
// --svg-only to skip them. The style matches docs/images/benchmark-chart.png.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---- Numbers: update these when rounds finish -------------------------------------------
const PAST_1M = {
  title: 'Past the context window',
  subtitle: '1.15M-token session, mean of 3 rounds',
  findingsTotal: 8,
  arms: [
    { name: 'MemTree', score: 69.8, findings: 8, detail: '3 fully, 5 partly', highlight: true },
    { name: '/compact', score: 23.0, findings: 0, detail: 'no changes made' },
  ],
};
const WITHIN_800K = {
  title: 'Inside the window',
  subtitle: '775k-token session, Oct 20 rerun',
  note: 'MemTree: mean of the 2 clean rounds',
  arms: [
    { name: 'MemTree', score: 65.3, highlight: true },
    { name: 'Full context', score: 66.3 },
    { name: '/compact', score: 44.5 },
  ],
};
const BADGE = 'Claude Opus 5.5 · graded blind';
// -----------------------------------------------------------------------------------------

const H = 398; // 2x -> 796 px tall, like benchmark-chart.png
const PLOT_TOP = 92;
const PLOT_BOTTOM = 300;
const FONT = "'DM Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";
const MONO = "'SF Mono',Monaco,Menlo,monospace";
const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(HERE, '../../docs/images');
const CHROME = process.env.CHROME
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

main();

function main() {
  const svgOnly = process.argv.includes('--svg-only');
  const single = chartSvg([{ panel: PAST_1M, x: 0, w: 700 }], 700);
  const both = chartSvg(
    [{ panel: PAST_1M, x: 0, w: 640 }, { panel: WITHIN_800K, x: 640, w: 760 }], 1400);
  for (const [name, svg] of [['benchmark-past-1m', single], ['benchmark-past-1m-with-800k', both]]) {
    const svgPath = join(OUT_DIR, `${name}.svg`);
    writeFileSync(svgPath, svg);
    console.log(`wrote ${svgPath}`);
    if (!svgOnly) renderPng(svgPath, join(OUT_DIR, `${name}.png`), svgWidth(svg));
  }
}

function chartSvg(panels, width) {
  const body = panels.map(({ panel, x, w }, i) => panelSvg(panel, x, w, i > 0)).join('\n');
  const label = panels.map(({ panel }) => panel.arms
    .map((a) => `${a.name} ${Math.round(a.score)}`).join(', ')).join('; ');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${H}" `
    + `viewBox="0 0 ${width} ${H}" font-family="${FONT}" role="img" `
    + `aria-label="Judged score out of 100: ${esc(label)}">
${defs()}
<rect width="${width}" height="${H}" fill="url(#bg)"/>
<rect width="${width}" height="${H}" fill="url(#glow)"/>
${body}
${badge(width / 2, 366)}
</svg>
`;
}

function panelSvg(panel, x0, w, divider) {
  const left = x0 + 92;
  const right = x0 + w - 28;
  const parts = [];
  if (divider) {
    parts.push(`<line x1="${x0}" y1="40" x2="${x0}" y2="${PLOT_BOTTOM + 30}" `
      + 'stroke="rgba(255,255,255,0.08)"/>');
  }
  parts.push(`<text x="${(left + right) / 2}" y="34" text-anchor="middle" font-size="17" `
    + `font-weight="700" fill="#fff">${esc(panel.title)}</text>`);
  parts.push(`<text x="${(left + right) / 2}" y="54" text-anchor="middle" font-size="12" `
    + `fill="rgba(255,255,255,0.6)">${esc(panel.subtitle)}</text>`);
  parts.push(axis(x0, left, right));
  const slot = (right - left) / panel.arms.length;
  const barW = Math.min(150, slot * 0.72);
  panel.arms.forEach((arm, i) => {
    parts.push(bar(arm, left + slot * (i + 0.5), barW, panel.findingsTotal));
  });
  if (panel.note) {
    parts.push(`<text x="${right}" y="${PLOT_BOTTOM + 44}" text-anchor="end" font-size="10" `
      + `fill="rgba(255,255,255,0.45)">${esc(panel.note)}</text>`);
  }
  return parts.join('\n');
}

function axis(x0, left, right) {
  const out = [`<text transform="translate(${x0 + 22} ${(PLOT_TOP + PLOT_BOTTOM) / 2}) `
    + 'rotate(-90)" text-anchor="middle" font-size="11" font-weight="600" letter-spacing="0.5" '
    + 'fill="rgba(255,255,255,0.55)">Score</text>'];
  for (let v = 0; v <= 100; v += 20) {
    const y = yFor(v);
    const stroke = v === 0 ? 'rgba(255,255,255,0.22)' : 'rgba(255,255,255,0.06)';
    out.push(`<line x1="${left}" y1="${y}" x2="${right}" y2="${y}" stroke="${stroke}"/>`);
    out.push(`<text x="${left - 10}" y="${y + 4}" text-anchor="end" font-family="${MONO}" `
      + `font-size="10" fill="rgba(255,255,255,0.55)">${v}%</text>`);
  }
  return out.join('\n');
}

function bar(arm, cx, barW, findingsTotal) {
  const top = yFor(arm.score);
  const x = cx - barW / 2;
  const h = PLOT_BOTTOM - top;
  const hi = Boolean(arm.highlight);
  const fill = hi ? 'url(#green)' : 'url(#gray)';
  const stroke = hi ? 'none' : 'rgba(255,255,255,0.10)';
  const out = [];
  if (hi) out.push(`<rect x="${x}" y="${top}" width="${barW}" height="${h}" rx="6" `
    + 'fill="#6ee787" opacity="0.35" filter="url(#blur)"/>');
  out.push(`<path d="${roundTop(x, top, barW, h, 6)}" fill="${fill}" stroke="${stroke}"/>`);
  out.push(`<text x="${cx}" y="${top - 12}" text-anchor="middle" font-size="17" font-weight="700" `
    + `fill="${hi ? '#6ee787' : '#fff'}">${Math.round(arm.score)}%</text>`);
  out.push(`<text x="${cx}" y="${PLOT_BOTTOM + 24}" text-anchor="middle" font-size="13" `
    + `font-weight="600" fill="${hi ? '#6ee787' : 'rgba(255,255,255,0.9)'}">${esc(arm.name)}</text>`);
  if (findingsTotal !== undefined) out.push(findingsLabel(arm, cx, top, findingsTotal));
  return out.join('\n');
}

function findingsLabel(arm, cx, top, total) {
  const ink = arm.highlight ? '#0f2a17' : '#fff';
  const inside = PLOT_BOTTOM - top >= 64;
  const y = inside ? PLOT_BOTTOM - 40 : top - 84;
  return `<text x="${cx}" y="${y}" text-anchor="middle" fill="${inside ? ink : '#fff'}">`
    + `<tspan font-family="${MONO}" font-size="16" font-weight="700">`
    + `${arm.findings} of ${total}</tspan>`
    + `<tspan x="${cx}" dy="15" font-size="10">findings addressed</tspan>`
    + `<tspan x="${cx}" dy="13" font-size="10" opacity="0.8">${esc(arm.detail)}</tspan></text>`;
}

function badge(cx, cy) {
  const w = 214;
  return `<rect x="${cx - w / 2}" y="${cy - 15}" width="${w}" height="30" rx="15" `
    + 'fill="rgba(255,255,255,0.05)" stroke="rgba(255,255,255,0.12)"/>'
    + `<text x="${cx}" y="${cy + 4.5}" text-anchor="middle" font-size="12" `
    + `fill="rgba(255,255,255,0.75)">${esc(BADGE)}</text>`;
}

function defs() {
  return `<defs>
<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
<stop offset="0" stop-color="#121119"/><stop offset="1" stop-color="#1b1a24"/></linearGradient>
<radialGradient id="glow" cx="0.3" cy="0.45" r="0.6">
<stop offset="0" stop-color="#4ade80" stop-opacity="0.06"/>
<stop offset="1" stop-color="#4ade80" stop-opacity="0"/></radialGradient>
<linearGradient id="green" x1="0" y1="0" x2="0" y2="1">
<stop offset="0" stop-color="#93e9a8"/><stop offset="1" stop-color="#5cc86a"/></linearGradient>
<linearGradient id="gray" x1="0" y1="0" x2="0" y2="1">
<stop offset="0" stop-color="#5a5c6a" stop-opacity="0.85"/>
<stop offset="1" stop-color="#3a3b46" stop-opacity="0.85"/></linearGradient>
<filter id="blur" x="-30%" y="-30%" width="160%" height="160%">
<feGaussianBlur stdDeviation="12"/></filter>
<style>@import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;600;700&amp;display=swap');</style>
</defs>`;
}

function roundTop(x, y, w, h, r) {
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}`
    + `Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

function yFor(score) {
  return PLOT_BOTTOM - (score / 100) * (PLOT_BOTTOM - PLOT_TOP);
}

function svgWidth(svg) {
  return Number(/width="(\d+)"/.exec(svg)[1]);
}

function renderPng(svgPath, pngPath, width) {
  if (!existsSync(CHROME)) throw new Error(`Chrome not found at ${CHROME}; set CHROME`);
  const shot = join(mkdtempSync(join(tmpdir(), 'bench-chart-')), 'shot.png');
  // Load the SVG itself (not via <img>) so its DM Sans @import applies.
  execFileSync(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars',
    '--force-device-scale-factor=2', `--window-size=${width},${H}`,
    '--virtual-time-budget=3000', `--screenshot=${shot}`, `file://${svgPath}`], { stdio: 'ignore' });
  copyFileSync(shot, pngPath);
  console.log(`wrote ${pngPath}`);
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
