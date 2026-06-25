// One-shot theme transform: invert lightness per color (hue preserved) so the
// light Studio palette becomes a coherent dark one without losing the green
// identity. Monotonic lightness mapping => every prior contrast pair is kept.
import { readFileSync, writeFileSync } from 'node:fs';

const file = new URL('../src/styles.css', import.meta.url);
let css = readFileSync(file, 'utf8');

function hexToRgb(hex) {
  let h = hex.slice(1);
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}
function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
}
function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0; const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  return [h, s, l];
}
function hslToRgb(h, s, l) {
  if (s === 0) { const v = l * 255; return [v, v, v]; }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue = (t) => {
    if (t < 0) t += 1; if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [hue(h + 1 / 3) * 255, hue(h) * 255, hue(h - 1 / 3) * 255];
}

function darkify(hex) {
  const [r, g, b] = hexToRgb(hex);
  let [h, s, l] = rgbToHsl(r, g, b);
  // Invert lightness onto a dark range [0.07, 0.93]; cards/bg become dark,
  // dark text becomes light. Pale tints get desaturated so dark surfaces
  // read as near-neutral instead of neon; accents/text keep their saturation.
  const nl = 0.07 + (1 - l) * 0.86;
  const ns = l > 0.85 ? s * 0.55 : s;
  const [nr, ng, nb] = hslToRgb(h, ns, nl);
  return rgbToHex(nr, ng, nb);
}

let count = 0;
css = css.replace(/#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b/g, (m) => {
  count += 1;
  return darkify(m);
});

// Shadows: greenish light-theme shadows -> deeper black for a dark surface.
css = css.replace(/rgba\(34,\s*47,\s*39,\s*0\.08\)/g, 'rgba(0, 0, 0, 0.45)');
css = css.replace(/rgba\(34,\s*47,\s*39,\s*0\.12\)/g, 'rgba(0, 0, 0, 0.55)');

// Tell the UA to render form controls / scrollbars dark.
if (!css.includes('color-scheme: dark')) {
  css = `html {\n  color-scheme: dark;\n}\n\n` + css;
}

writeFileSync(file, css);
console.log(`darkened ${count} color tokens`);
