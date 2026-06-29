# Scripted theme transform

**Industry name(s):** a CSS codemod / one-shot stylesheet transform in HSL space; theming by
build script rather than design tokens. **Type:** Project-specific (the codemod approach);
the color-space math (RGB↔HSL, hue-preserving lightness inversion) is industry standard.

## Zoom out, then zoom in

Studio's look is the reincodes theme — stark monochrome `#0a0a0a`/`#ededed`, purple titles,
a single red accent. But there's no design-token layer producing it. The palette was derived
by running two Node scripts that **rewrote the hex literals in `styles.css` in place**. Here's
where the theme transform (the `*-theme.mjs` scripts) sits.

```
  Zoom out — where the theme transform lives

  ┌─ Tooling layer (scripts/) ───────────────────────────────┐
  │  ★ darkify-theme.mjs → reincodes-theme.mjs ★  ← we're here │  ← run ONCE, by hand
  │     read styles.css → rewrite every hex → write styles.css│
  └───────────────────────────────┬──────────────────────────┘
                                  │ produces
  ┌─ Source layer ────────────────▼──────────────────────────┐
  │  src/styles.css  (literal hex: #0a0a0a #ededed #a78bfa …) │
  └───────────────────────────────┬──────────────────────────┘
                                  │ imported once
  ┌─ App layer ───────────────────▼──────────────────────────┐
  │  main.tsx:14  import './styles.css'  → every component     │
  └───────────────────────────────────────────────────────────┘
```

Zoom in: the question is *"how do you reskin an entire dark green-tinted stylesheet into a
monochrome-plus-red theme without hand-editing hundreds of color literals or introducing a
token system?"* The answer: treat the stylesheet as data and run a hue/lightness transform
over every hex match — a codemod, not a refactor.

## Structure pass

**Layers:** the scripts (transform) → `styles.css` (the literal palette) → the components
(consume class names).

**One axis — *when is the color value decided?*** This is the contrast that explains the
whole approach:

```
  Axis: "when is a color's value fixed?"

  ┌─ token system (NOT used here) ───┐  → at RUNTIME: var(--accent) resolves in the browser;
  │                                  │    change one :root value, everything recolors live
  └───────────────────────────────────┘
  ┌─ scripted codemod (used here) ───┐  → at AUTHOR time: the script bakes literal hex into
  │                                  │    styles.css once; the browser sees only literals
  └───────────────────────────────────┘
```

**The seam that matters:** the regex that matches every hex literal
(`reincodes-theme.mjs:57`). That's where "stylesheet" becomes "list of colors to transform."
The transform is pure per-color (`reskin(hex) → hex`), so it's a stateless map over matches —
which is exactly why a regex codemod is safe here and a token system would be the heavier,
runtime-resolved alternative.

## How it works

### Move 1 — the mental model

You've written a codemod or a find-and-replace migration — walk the source, match a pattern,
rewrite each match by a rule, write it back. This is that, where the "source" is CSS and the
"pattern" is a hex color. The rule isn't string replacement, though — each color is converted
to HSL, transformed in that space (so the *relationships* between colors survive), and
converted back. Two scripts run in sequence: first darken, then desaturate.

```
  The pattern — pure per-color map over the stylesheet

  styles.css ──regex /#[0-9a-f]{6}|#[0-9a-f]{3}/──► [ #1a2b1a, #ededed, … ]
                                                          │ reskin(hex)
                              hexToRgb → rgbToHsl → transform(h,s,l) → hslToRgb → rgbToHex
                                                          ▼
  darkify:   invert lightness, keep hue   →  light theme → coherent dark theme
  reincodes: desaturate all hue→gray EXCEPT red, keep lightness  →  monochrome + red accent
```

### Move 2 — the step-by-step walkthrough

**Match every color literal.** The regex catches both 6-digit and 3-digit hex; the replace
callback runs `reskin` on each and counts them. This is the codemod's spine.

```js
// reincodes-theme.mjs:56-60
let count = 0;
css = css.replace(/#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b/g, (m) => {
  count += 1;
  return reskin(m);
});
```

The boundary condition: it matches *only* hex literals. An `rgb()` or `hsl()` color, or a
named color (`black`), would slip through untouched. The stylesheet happens to use hex
throughout, so this is sufficient — but it's the assumption that makes the codemod work, and
the thing that would silently miss a color if someone added one in another notation.

**Transform in HSL so relationships survive.** The reincodes pass desaturates everything to
gray *except* reds, and preserves lightness — so the dark elevation/contrast structure built
into the original palette is untouched; only the hue changes.

```js
// reincodes-theme.mjs:47-54
function reskin(hex) {
  const [r, g, b] = hexToRgb(hex);
  const [h, s, l] = rgbToHsl(r, g, b);
  const isRed = s > 0.12 && (h <= 0.045 || h >= 0.955);   // saturated + hue near 0°/360°
  const ns = isRed ? Math.min(s, 0.62) : 0;               // red kept (capped); else → gray
  const [nr, ng, nb] = hslToRgb(isRed ? h : 0, ns, l);    // lightness L preserved throughout
  return rgbToHex(nr, ng, nb);
}
```

Why HSL and not a naive RGB tweak: lightness `l` is carried straight through, so a color
that was a "mid-elevation surface" stays mid-elevation — its contrast against text doesn't
move. Only saturation collapses to 0 (gray) unless the hue is red. That's the load-bearing
idea: transform the *axis you want to change* (hue/saturation) and freeze the axis that
encodes hierarchy (lightness).

**The darkify pass — the earlier transform.** `darkify-theme.mjs` runs first and inverts
lightness per color while keeping hue, with a *monotonic* lightness mapping so every prior
contrast pair is preserved (a light bg vs darker text stays ordered after inversion). It turns
the original light palette into a coherent dark one (`darkify-theme.mjs:1-3`).

```
  Comparison — the two passes, in order

  original (light, green-tinted)
        │ darkify-theme.mjs:  L → 1−L (monotonic), hue kept
        ▼
  dark green-tinted theme
        │ reincodes-theme.mjs: hue→gray except red, L kept
        ▼
  reincodes monochrome + red   (the #0a0a0a / #ededed / #ef4444 you see today)
```

**The output is just literals.** After the scripts run, `styles.css` contains baked hex
(`#0a0a0a`, `#ededed`, `#a78bfa`, `#ef4444` — `styles.css:7-8,191,15`). The browser never sees
the transform; it sees a normal stylesheet imported once at `main.tsx:14`. No runtime cost, no
custom properties.

### Move 2 variant — the load-bearing skeleton

The kernel: **a pure per-color transform in a perceptual color space, mapped over every
literal in the stylesheet.**

1. **The hex-matching regex** — drop it and you're hand-editing hundreds of literals; the
   whole point was to not do that.
2. **The HSL round-trip** — drop it (transform RGB directly) and you can't cleanly say "change
   hue/saturation, keep lightness"; contrast relationships break.
3. **Lightness preservation** (reincodes) / **monotonic lightness** (darkify) — this is what
   keeps the elevation hierarchy intact across the transform. Drop it and the theme loses its
   depth structure even if the hues are right.
4. **The red exception** — the one branch that keeps an accent; without it the result is pure
   grayscale with no signal color for errors.

There's no hardening layer here — it's a one-shot script, run by hand, not wired into the
build (`package.json` scripts are just `dev`/`build`/`build:pages`/`preview`).

### Move 3 — the principle

When you want to transform a *relationship* across many values — recolor a whole palette while
keeping its contrast structure — move into the space where that relationship is an explicit
axis (HSL: hue, saturation, lightness), transform the axes you mean to change, and freeze the
one that encodes the structure. The honest tradeoff: this is a *destructive author-time*
transform, not a *composable runtime* one. It got the theme done in two scripts, but the
result is literal hex with no token layer — so the next palette change means re-deriving, not
editing one variable (audit red flag #4). For a fixed brand on a small app, that was the right
call; the move *toward* design tokens is `:root` custom properties.

## Primary diagram

```
  Scripted theme transform — full picture

  ┌─ scripts/ (run once, by hand) ────────────────────────────────────────┐
  │  darkify-theme.mjs        reincodes-theme.mjs                          │
  │  read styles.css ─► regex match every #hex ─► reskin(hex):             │
  │     hexToRgb → rgbToHsl → [darkify: L→1−L] / [reincodes: S→0 unless red]│
  │     → hslToRgb → rgbToHex ─► write styles.css                          │
  └───────────────────────────────────┬───────────────────────────────────┘
                                      │ baked literals
  ┌─ src/styles.css (no tokens) ──────▼───────────────────────────────────┐
  │  #0a0a0a bg · #ededed text · #a78bfa titles · #ef4444 accent           │
  │  .topbar::before { width:100vw; left:50%; translateX(-50%) }  ← full-bleed│
  │  .shellNarrow 720px (home) · .shellDoc 1120px (docs)                    │
  └───────────────────────────────────┬───────────────────────────────────┘
                                      │ import './styles.css' (main.tsx:14)
  ┌─ components ──────────────────────▼───────────────────────────────────┐
  │  class names only — no inline color, no CSS-in-JS                      │
  └───────────────────────────────────────────────────────────────────────┘
```

## Elaborate

This is the opposite end of the spectrum from a design-token / theme-context system, which
resolves `var(--accent)` at runtime and recolors live when one root value changes. Studio
chose the codemod because it had one existing stylesheet and wanted one fixed brand — the
cheapest path was to transform the literals once, not to refactor every rule to reference a
variable. The HSL math (the `hexToRgb`/`rgbToHsl`/`hslToRgb` helpers, duplicated across both
scripts) is textbook color-space conversion; the only judgment calls are the red-detection
thresholds (`s > 0.12`, hue near 0°/360°) and the saturation cap (`0.62`). The full-bleed
sticky header (`styles.css:68-78`) and the dual shell widths (`styles.css:39-49`) are the
other notable hand-written CSS techniques worth knowing — both are pure CSS, no JS. Runtime
theming, dark/light toggle, and design tokens are all `not yet exercised` (audit lens 6); the
upgrade path is named there.

## Interview defense

**Q: How was the theme produced, and why not design tokens?**
Two Node scripts treat `styles.css` as data: match every hex literal, convert to HSL,
transform, convert back, write the file. The first inverts lightness (light→dark, hue kept);
the second desaturates every hue to gray except red, keeping lightness. It's a one-shot
codemod for a fixed brand — cheaper than refactoring every rule onto CSS variables. The cost,
named honestly, is that there's no runtime token layer: the next palette change means
re-deriving, not editing one variable.

```
  light theme ──darkify (L→1−L, hue kept)──► dark theme
              ──reincodes (S→0 except red, L kept)──► monochrome + red
```

Anchor: *"transform the hue, freeze the lightness — the contrast structure survives."*

**Q: Why HSL instead of just editing RGB?**
Because the thing I wanted to change (hue, saturation) and the thing I wanted to keep
(lightness, which encodes elevation/contrast) are separate axes in HSL but tangled in RGB.
Converting in lets me collapse saturation to gray while carrying lightness straight through,
so a mid-elevation surface stays mid-elevation.

Anchor: *"HSL makes 'recolor but keep the contrast' a one-line change."*

## See also

- `00-overview.md` — the two-build / `STATIC_DEMO` split (also a styling-adjacent gate)
- `audit.md` — lens 6 (styling) and red flag #4 (no token layer)
- `study-software-design` — codemod-vs-token-system as a complexity tradeoff
- `study-performance-engineering` — literal-hex CSS has zero runtime theming cost (a plus here)
