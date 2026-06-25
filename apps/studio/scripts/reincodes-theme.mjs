// Re-skin the Studio palette to match reincodes: a stark monochrome dark theme
// (#0a0a0a bg, #ededed text, neutral grays) whose only accent is red. Operates
// on the current (dark, green-tinted) styles.css: desaturate every hue to gray,
// EXCEPT reds — red is reincodes' accent, so error/negative states keep it.
// Lightness is preserved, so the dark elevation/contrast structure is untouched.
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

function reskin(hex) {
  const [r, g, b] = hexToRgb(hex);
  const [h, s, l] = rgbToHsl(r, g, b);
  const isRed = s > 0.12 && (h <= 0.045 || h >= 0.955);
  const ns = isRed ? Math.min(s, 0.62) : 0; // keep red as the accent; everything else -> gray
  const [nr, ng, nb] = hslToRgb(isRed ? h : 0, ns, l);
  return rgbToHex(nr, ng, nb);
}

let count = 0;
css = css.replace(/#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b/g, (m) => {
  count += 1;
  return reskin(m);
});

writeFileSync(file, css);
console.log(`reskinned ${count} color tokens to monochrome+red`);
