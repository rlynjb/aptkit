# 06 — Scripted theme transform

**Industry name(s):** programmatic palette transformation / author-time CSS
re-skinning (no design tokens). **Type:** Project-specific (a Node script that
rewrites hex literals in `styles.css` in place).

## Zoom out, then zoom in

Studio's dark monochrome theme wasn't hand-typed color by color, and it isn't a
set of CSS variables you can flip at runtime. It was *generated*: two Node
scripts read `styles.css`, transform every hex literal through a color-space
algorithm, and write the file back. Here's where it sits.

```
  Where theming happens

  ┌─ Author time (Node, run by hand) ───────────────────────────┐
  │  scripts/darkify-theme.mjs   invert lightness, keep hue      │
  │  scripts/reincodes-theme.mjs desaturate all hues except red  │
  │            │ read → transform every #hex → write back        │
  │            ▼                                                  │
  │  ★ src/styles.css (hex literals rewritten in place) ★ ← here │
  └───────────────────────────┬─────────────────────────────────┘
                              │  import (build), static
  ┌─ Browser (runtime) ──────▼──────────────────────────────────┐
  │  one global stylesheet · NO CSS variables · NO runtime theme │
  └──────────────────────────────────────────────────────────────┘
```

Zoom in: the question is *"how do you re-skin a whole stylesheet — light→dark,
then green→monochrome — without hand-editing hundreds of color values or
introducing a token system?"* The answer: treat the CSS as data, run every color
through a deterministic transform in HSL space, and commit the result. The theme
is a *build artifact of a script*, not a runtime feature.

## Structure pass

**Layers:** (1) the transform scripts (color-space math); (2) `styles.css` (the
mutated artifact); (3) the rendered UI.

**Axis — *when does a color get decided* (lifecycle):**

```
  axis: when is the palette fixed?

  ┌ author time ──────┐  scripts run ONCE → hex literals rewritten
  │ darkify/reincodes │  this is the only place a color changes
  └──────────┬────────┘
  ┌ build ─────▼──────┐  styles.css imported as-is (no transform)
  │ Vite              │
  └──────────┬────────┘
  ┌ runtime ───▼──────┐  fixed — no variable to flip, no toggle
  │ browser           │
  └───────────────────┘
```

**Seam:** the regex that matches every `#rrggbb`/`#rgb` literal. That's where
"a stylesheet" becomes "transformable data." The axis flips there: above it
colors are opaque strings; the regex turns each into a number the transform can
reason about. The deeper seam — the one that's *missing* — is a CSS-variable
layer between author-time and runtime, which is exactly why runtime theming is
impossible here (`audit.md` #3).

## How it works

### Move 1 — the mental model

You know a codemod: a script that parses your code, transforms nodes, and writes
it back, so you don't hand-edit 200 call sites. This is a codemod for *colors* —
match every hex, convert to HSL, apply a lightness/saturation rule, convert
back, write the file. The CSS is the AST; hex literals are the nodes.

```
  The kernel — color codemod

   read styles.css
        │
        ▼  regex: /#[0-9a-fA-F]{6}|#[0-9a-fA-F]{3}/g
   for each #hex:  hex → RGB → HSL → transform(H,S,L) → RGB → #hex
        │
        ▼
   write styles.css   (every color remapped, structure untouched)
```

The kernel: **match every color + a per-color transform in HSL + write back**.
Drop the HSL step (transform in RGB) and you'd shift hues and wreck contrast;
HSL is what lets you move lightness *without* moving hue.

### Move 2 — the walkthrough

**Transform one — `darkify`: invert lightness, preserve hue.**
The first pass turned the original light, green-tinted palette into a coherent
dark one. The rule: flip lightness onto a dark range, keep the hue, gently
desaturate pale tints so dark surfaces read neutral instead of neon.

```js
// apps/studio/scripts/darkify-theme.mjs:45-55
function darkify(hex) {
  const [r, g, b] = hexToRgb(hex);
  let [h, s, l] = rgbToHsl(r, g, b);
  const nl = 0.07 + (1 - l) * 0.86;            // invert lightness into [0.07, 0.93]
  const ns = l > 0.85 ? s * 0.55 : s;          // pale tints → less saturated on dark
  const [nr, ng, nb] = hslToRgb(h, ns, nl);    // hue h UNCHANGED
  return rgbToHex(nr, ng, nb);
}
```

The load-bearing choice is `nl = 0.07 + (1 - l) * 0.86` — a *monotonic*
lightness mapping. Because it's monotonic, every contrast pair that was distinct
before stays distinct after (lighter-than relationships are preserved), so the
dark theme doesn't collapse two previously-distinguishable grays into one. That's
the "what breaks if you skip it" insight: a non-monotonic remap would silently
destroy contrast.

**Transform two — `reincodes`: desaturate everything except red.**
The second pass took that dark green theme to stark monochrome — gray
everything, but keep red as the single accent (error/negative states).

```js
// apps/studio/scripts/reincodes-theme.mjs:47-54
function reskin(hex) {
  const [r, g, b] = hexToRgb(hex);
  const [h, s, l] = rgbToHsl(r, g, b);
  const isRed = s > 0.12 && (h <= 0.045 || h >= 0.955);   // hue near 0 = red
  const ns = isRed ? Math.min(s, 0.62) : 0;               // red kept (capped); else → gray
  const [nr, ng, nb] = hslToRgb(isRed ? h : 0, ns, l);    // lightness L UNCHANGED
  return rgbToHex(nr, ng, nb);
}
```

This pass keeps *lightness* fixed (`l` unchanged) and zeroes saturation for
non-reds — so the dark elevation/contrast structure built by `darkify` survives
untouched while the hue identity is stripped to gray+red. Two passes, each
holding one HSL channel constant: darkify moves lightness, reincodes moves
saturation. That separation is why they compose cleanly.

**The shared mechanism — match, map, write.**
Both scripts share the same outer loop: a regex over every hex, a counter, a
write-back. Self-similar — name it once.

```js
// apps/studio/scripts/reincodes-theme.mjs:56-62 (darkify-theme.mjs:57-61 is identical shape)
let count = 0;
css = css.replace(/#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b/g, (m) => {
  count += 1;
  return reskin(m);                 // darkify uses darkify(m); same harness
});
writeFileSync(file, css);
console.log(`reskinned ${count} color tokens to monochrome+red`);
```

`darkify` also patches two `rgba()` shadow values and prepends `color-scheme:
dark` (`darkify-theme.mjs:64-70`) — the bits a pure hex regex can't reach. The
boundary condition: the regex only sees `#hex`; any color written as
`rgb()`/`hsl()`/named would be missed, which is why the shadow `rgba()`s need an
explicit second replace.

**The sibling technique — full-bleed sticky header (CSS, not script).**
Worth covering here because it's the other distinctive styling move. The black
header bleeds edge-to-edge while its content stays aligned to the content column
— done with negative margins plus a `100vw` pseudo-element.

```css
/* apps/studio/src/styles.css:51-78 (trimmed) */
.topbar { position: sticky; top: 0; margin: -24px -24px 18px; background: #000; }
.topbar::before {                 /* paint black across the FULL window width */
  content: ''; position: absolute; top: 0; bottom: 0;
  left: 50%; width: 100vw; transform: translateX(-50%);  /* center a 100vw band */
  background: #000; z-index: -1;
}
/* styles.css:3 */  html { overflow-x: hidden; }   /* contain the 100vw bleed */
```

The `100vw` + `translateX(-50%)` is the trick: the header content respects the
720/1120px shell, but the `::before` paints a full-viewport-width black band
behind it. `overflow-x: hidden` on `html` is the required guard — without it the
`100vw` band (wider than the content area, ignoring the scrollbar) causes a
horizontal scrollbar.

### Move 3 — the principle

When a transformation is mechanical and uniform, treat the source as data and
write a transform instead of hand-editing — and do color work in HSL, where you
can hold hue or lightness constant and move only the channel you mean to. The
cost, named plainly: because the transform writes *literal* hex into the CSS
rather than CSS variables, the theme is frozen at author time — no runtime
toggle, no per-user theme, without re-running the script and rebuilding. The
script bought a one-time re-skin; it did not buy a theme *system*. Promoting the
palette to CSS custom properties is the move if runtime theming ever matters
(`audit.md` #3).

## Primary diagram

```
  Scripted theme transform — the complete picture

  ┌─ AUTHOR TIME (Node) ─────────────────────────────────────────┐
  │  styles.css (input) ─► regex match every #hex                 │
  │     │                                                         │
  │     ├─ darkify:   hex→HSL→ invert L (monotonic), keep H →hex  │
  │     │             + patch rgba() shadows + color-scheme:dark  │
  │     └─ reincodes: hex→HSL→ S=0 unless red, keep L →hex        │
  │     ▼                                                         │
  │  styles.css (output, hex literals rewritten in place)         │
  └───────────────────────────┬─────────────────────────────────┘
                              ▼  import (build) — no further transform
  ┌─ RUNTIME (browser) ──────────────────────────────────────────┐
  │  monochrome dark: #0a0a0a bg · #ededed text · #a78bfa titles  │
  │  · #ef4444 red accent · full-bleed 100vw sticky header        │
  │  NO CSS variables → NO runtime theme switch                   │
  └────────────────────────────────────────────────────────────────┘
```

## Elaborate

This is a codemod applied to styling — the same instinct as `jscodeshift` for
JS, here over CSS color literals. Working in HSL is the standard move for palette
work: RGB transforms shift perceived hue and break contrast, while HSL lets you
isolate lightness (darkify) or saturation (reincodes) and leave the rest alone.
The two-pass design — one channel per pass — is why they compose without
fighting each other. The thing to internalize is what the approach *isn't*: it's
the opposite of a design-token system. Tokens centralize color as named
variables resolved at runtime; this centralizes the *transform* at author time
and bakes the result. For a single-theme demo that's the lighter call; the
moment a second theme or a user toggle appears, tokens win. The full-bleed
header is unrelated tech (pure CSS) but the same "distinctive styling decision
worth understanding" category, so it rides along here.

## Interview defense

**Q: Why a script instead of just editing the CSS or using a token system?**
The re-skin was uniform and mechanical — invert lightness on every color, then
desaturate all but red. Hand-editing hundreds of hex values is error-prone;
treating the stylesheet as data and running a deterministic HSL transform does
it in one pass and is repeatable. A token system would be the answer if I needed
*runtime* theming, but this is a single fixed dark theme, so I bought the re-skin
without the indirection.

**Q: Why HSL, and why two passes?**
HSL separates the channels: I can change lightness without touching hue, or
saturation without touching lightness. Pass one (darkify) inverts lightness with
a *monotonic* mapping so every existing contrast pair survives, keeping hue.
Pass two (reincodes) zeroes saturation except for red, keeping lightness — so
the dark contrast structure from pass one is untouched. Each pass holds one
channel constant; that's why they compose.

```
  two passes, one channel each

  darkify   : move L (monotonic), hold H   → light→dark, green kept
  reincodes : move S (→0 unless red), hold L → green→gray+red
```

**Q: What's the cost of baking hex instead of using variables?**
The theme is frozen at author time. There's no CSS variable to flip, so a
light-mode toggle or per-user theme is impossible without re-running the script
and rebuilding. Acceptable for a single-theme demo; the fix if it mattered is to
emit CSS custom properties on `:root` so the script sets variables once and
runtime theming becomes a class swap.

**Anchor:** *"The stylesheet is data — an HSL codemod, monotonic lightness so
contrast survives — but it bakes literal hex, so there's no runtime theme."*

## See also

- `00-overview.md` — the palette and layout widths in context.
- `audit.md` → lens 6 (styling/design-system), #3 (no runtime theme).
- `05-fixture-as-build-input.md` — the other "author/build-time artifact, not a
  runtime feature" decision.
- `study-performance-engineering` — a single stylesheet, no CSS-in-JS runtime
  cost; measurement lives there.
