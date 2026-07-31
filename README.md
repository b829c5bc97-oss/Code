# Pratham — AI Automation Developer

A clean, readable one-page portfolio with a contained 3D hero, a bento-grid
layout, and scroll-reveal animations.

## Design notes

- **3D is contained to the hero only.** A distorted, glowing icosahedron core
  (simplex-noise vertex displacement + fresnel indigo/cyan rim + additive
  wireframe shell) renders into a hero-scoped canvas and sits on the right, so it
  never overlaps or obscures body text. A gradient scrim keeps the hero heading
  fully legible.
- **Readability first.** Every section sits on a solid surface with strong
  contrast. Standard native scrolling — no scroll hijacking.
- **Bento grid** services layout, clean project cards, two-column experience list.
- **Scroll-reveal** via IntersectionObserver, subtle hover lifts, a marquee, and a
  live-status pill.
- Fully responsive with a mobile menu, and honours `prefers-reduced-motion`.

## Run it

No build step. Double-click `index.html`, or serve locally:

```bash
python3 -m http.server 8000   # open http://localhost:8000
```

## Structure

```
index.html      # content + markup
css/style.css   # theme, bento layout, all styling
js/scene.js     # hero-contained 3D core (Three.js)
js/main.js      # reveals, mobile menu, active-nav
```

Three.js is loaded from a CDN (`three@0.160.0`).

## Customize

- Accent colors are CSS variables at the top of `css/style.css`
  (`--accent`, `--accent-2`, `--grad`).
- Contact email is in `index.html` (`#contact`).
- Core color / displacement is configurable near the top of `js/scene.js`.
