# AI Automation Developer — Resume Site

A single-page scrolling resume/portfolio site with a live 3D animated background,
scroll-reveal sections, and interactive tilt cards.

## Features

- **3D background** — floating wireframe shapes + particle field rendered with Three.js,
  reacting to mouse movement and scroll position.
- **Scroll-driven reveals** — sections and cards fade/slide into view via IntersectionObserver.
- **Interactive tilt cards** — project cards respond to cursor with a 3D perspective tilt.
- **Cursor glow** and animated loader.
- **Fully responsive** with a mobile slide-in menu.
- **Reduced-motion aware** — animations soften when the OS requests reduced motion.

## Running

No build step. Open `index.html` directly, or serve locally:

```bash
python3 -m http.server 8000
# then visit http://localhost:8000
```

## Structure

```
index.html      # markup + content
css/style.css   # dark theme, layout, animations
js/three-bg.js  # Three.js animated background scene
js/main.js      # nav, scroll reveal, tilt, cursor glow
```

Three.js is loaded from a CDN (`three@0.160.0`).

## Customize

- Contact email lives in `index.html` (`#contact` section).
- Colors are CSS variables at the top of `css/style.css` (`--accent`, `--accent-2`).
- Scene density/colors are configurable near the top of `js/three-bg.js`.
