# AI Automation Developer — Portfolio

A one-page, scroll-driven portfolio with an editorial layout and a custom WebGL
scene. Built to feel like a design-studio site, not a template.

## What makes it different

- **Custom GLSL shader background** — a flowing fractal-noise "aurora" that shifts
  color as you scroll and drifts with your cursor (not floating polygons).
- **Living 3D core** — a high-subdivision icosahedron displaced by 3D simplex noise
  in the vertex shader, with a fresnel lime/iridescent rim + additive wireframe shell.
  It reacts to cursor proximity and scroll progress.
- **Inertia smooth-scroll** — lerped, momentum-based scrolling (falls back to native
  scroll on touch / reduced-motion).
- **Pinned horizontal work gallery** — the projects scroll sideways as you move down.
- **Kinetic typography** — hero headline reveals word-by-word from a clip mask.
- **Blend-mode custom cursor** with a lagging ring that grows on interactive elements.
- **Magnetic buttons**, a fullscreen circular-reveal menu, marquee, and a numeric
  preloader.
- **Accessible**: honours `prefers-reduced-motion` and degrades to native scroll on
  touch devices.

## Run it

No build step. Either double-click `index.html`, or serve locally:

```bash
python3 -m http.server 8000   # then open http://localhost:8000
```

## Structure

```
index.html      # content + markup
css/style.css   # editorial dark theme, acid-lime signature, all layout/animation
js/scene.js     # WebGL: shader aurora background + distorted 3D core
js/smooth.js    # inertia smooth-scroll + scroll-progress signal
js/main.js      # preloader, split-text, cursor, magnetic, reveals, gallery, menu
```

Three.js is loaded from a CDN (`three@0.160.0`).

## Customize

- Accent + gradient live as CSS variables at the top of `css/style.css`
  (`--lime`, `--grad`).
- Contact email is in `index.html` (`#contact`) and the menu footer.
- Shader colors / core displacement are configurable near the top of `js/scene.js`.
