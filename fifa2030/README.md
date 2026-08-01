# FIFA World Cup 2030 — Centenary Title Sequence

A 90-second broadcast title sequence for the centenary edition of the FIFA World
Cup, built as a real, renderable codebase in [Remotion](https://remotion.dev).

**2030 marks 100 years of the FIFA World Cup** — not 100 years of FIFA. The
first tournament was Uruguay 1930. The film's arc is
**Origin → Journey → Unity**: the tournament returns to the Estadio Centenario
in Montevideo, where it began, then travels forward across six nations and three
continents to one stadium, one crowd, one game.

Final frame: **Football Unites the World**.

---

## Quick start

```bash
npm install
npm run dev          # Remotion Studio — live preview of all twelve shots
npm run build        # tsc --noEmit, strict mode
```

## Render

```bash
# Master deliverable — 1920×1080, 30fps, 90.0s, H.264, CRF 16
npx remotion render FIFA2030Intro out/fifa2030.mp4

# Social variants
npx remotion render FIFA2030Intro-Vertical out/fifa2030-vertical.mp4   # 1080×1920
npx remotion render FIFA2030Intro-Square   out/fifa2030-square.mp4     # 1080×1080

# Fast review pass (roughly 10× quicker)
npm run preview      # --jpeg-quality=60 --scale=0.5
```

Codec, CRF, pixel format and the GL renderer are pinned in `remotion.config.ts`,
so the bare `remotion render` command already produces the delivery spec — no
flags required.

**Chromium.** `remotion.config.ts` reuses a system Chromium if one is present at
a known path, and otherwise falls back to Remotion's own managed download. On a
normal developer machine this needs no configuration. To force a specific
binary, set `REMOTION_BROWSER_EXECUTABLE`.

---

## The three aspect ratios

All three compositions render the **same component tree**. There are no
per-format scene forks and no hardcoded pixel positions anywhere in `src/`.

Layout comes from `src/config/layout.ts`, which exposes:

| Helper   | Use for                                                          |
| -------- | ---------------------------------------------------------------- |
| `u(n)`   | Spacing, stroke widths, graphic sizes — 1/100th of the short edge |
| `t(n)`   | Font sizes — width-aware, so headlines don't overflow at 9:16     |
| `pick()` | The few genuinely per-format decisions (e.g. globe framing)       |

Everything else is percentage or flex. `t()` is constrained by width as well as
height, which is what stops a line set for 16:9 from running off a 9:16 frame.

---

## Shot list

| #     | Shot                | Frames    | Time        | Notes                                              |
| ----- | ------------------- | --------- | ----------- | -------------------------------------------------- |
| 01    | First Touch         | 0–180     | 0:00–0:06   | Black, one ball, a boot. Contact on frame 46        |
| 02    | Estadio Centenario  | 180–420   | 0:06–0:14   | 1930, sepia, 4:3 letterbox, Torre de los Homenajes  |
| 03    | 100 Years           | 420–840   | 0:14–0:28   | Gold rail, every edition 1930–2026, six hero holds  |
| 04    | The Globe           | 840–1080  | 0:28–0:36   | Three.js globe, six pins, great-circle arcs         |
| 05–10 | The Six Nations     | 1080–2160 | 0:36–1:12   | One 180-frame module, six configurations            |
| 11    | The Stadium         | 2160–2520 | 1:12–1:24   | Instanced crowd, unbroken descent, street inserts   |
| 12    | Unity Lockup        | 2520–2700 | 1:24–1:30   | Six nations assemble into one ball                  |

Total: **2700 frames · 30fps · exactly 90.0s**.

### Motion language

Cuts land on a 120 BPM grid — one beat every 15 frames — defined once in
`config/theme.ts` and derived everywhere else. All motion uses `spring()` and
`interpolate()`; the only linear moves are constant camera drifts and the
timeline rail. Signature transition is the football-panel `HexWipe`, with
`WhipPan` reserved for continent-to-continent jumps. Grain sits at 4% across the
whole film so twelve shots read as one piece of stock.

### Palette

Gold (`--gold-trophy`) is reserved **exclusively** for centenary moments: the
100 mark, the trophy, the year cards, the three centenary hosts, the final
lockup. It is never decorative.

---

## ⚠ Swap points — what the client edits, and where

Everything a rights-holder needs to replace is isolated. **No scene component
needs to be opened to swap any of it.**

### 1. Players — `src/config/players.ts`

**No real, identifiable footballer is depicted anywhere in this film.** Player
image rights are licensed separately from tournament rights and are the single
most common legal blocker on a sequence like this, so every player is a
high-contrast stylised silhouette driven by pose keyframes — readable by
**action, posture and jersey number**, never by face.

Each nation has one slot:

```ts
{
  nation: 'morocco',
  jerseyNumber: 7,
  signatureAction: 'Cutting inside from the right',
  poseKeyframes: [...],
  colorway: {field, figure, mark},
  assetSrc: undefined,   // ← set this
}
```

Set `assetSrc` to a path under `public/players/` (PNG or SVG with alpha, around
1000×1000) and `PlayerSilhouette` renders that licensed asset instead of the
vector figure. Nothing else changes. `jerseyNumber`, `colorway` and
`signatureAction` are likewise data.

The Shot 03 hero freeze-frames reuse the same pose tracks, so they are covered
by the same swap.

### 2. FIFA marks — `public/brand/`

Trademarked artwork is **referenced as swappable assets, never recreated in
code**. Drop the official files into `public/brand/` and reference them with
`staticFile()`. The ball in Shot 12 is a generic truncated icosahedron built
from geometry — it is deliberately not a trademarked mark.

### 3. Score — `public/audio/temp-score.mp3`

`public/audio/temp-score.mp3` is a **scratch track**, synthesised by
`tools/make-temp-score.mjs` to the structure in the brief:

| Time      | Section                                          |
| --------- | ------------------------------------------------ |
| 0:00–0:14 | Sparse percussion                                |
| 0:14–0:36 | Building strings + drums                         |
| 0:36–1:12 | Six cultural instrument features, one per nation |
| 1:12–1:24 | Full orchestral + choir swell                    |
| 1:24–1:30 | A single sustained note into silence             |

**To drop in the licensed score:** replace that file, same path, and re-render.
Nothing else changes as long as it is 90.0s at 120 BPM. If the final score is at
a different tempo, change `BPM` in `src/config/theme.ts` — the beat grid, the
cut points and the wipes all derive from it.

Regenerate the temp track with `node tools/make-temp-score.mjs`.

**Picture is genuinely locked to sound.** Two elements read the waveform via
`useAudioData` / `visualizeAudio` rather than approximating it:

- the **crowd wave intensity** in Shot 11
- the **gold particle burst scale** on the first touch in Shot 01

Both go through `useScoreAmplitude()` in `src/audio.ts`, which samples low
frequency energy — the kick and the orchestral body, what a crowd actually moves
to. Averaging the full spectrum would let cymbals drive the wave.

### 4. Content — `src/config/`

| File          | Holds                                                           |
| ------------- | --------------------------------------------------------------- |
| `nations.ts`  | All six hosts: colours, motifs, local script, host role, city    |
| `timeline.ts` | Every World Cup 1930–2026, hosts, winners, hero editions         |
| `geo.ts`      | Boundary rings as real lon/lat, projection and great-circle math |
| `theme.ts`    | Palette, type scale, spring vocabulary, BPM                      |
| `players.ts`  | The swappable player slots above                                 |

`timeline.ts` carries one open item: **2026's winner is `null`**, rendering as
an em-dash. Set it once known — nothing else needs editing.

### 5. Fonts — `public/fonts/`

Anton, Barlow and Noto Sans Arabic are **self-hosted**, not fetched from Google
at render time: a broadcast render must not depend on a network round trip, and
a missed font swap would change type metrics mid-render. To move to FIFA's brand
faces, drop the woff2 files in `public/fonts/` and edit the table in
`src/fonts.ts` plus `fontStacks` in `config/theme.ts`.

---

## Structure

```
src/
  Root.tsx                  # Composition registrations, all three aspect ratios
  FIFA2030Intro.tsx         # Master <Series> of all twelve shots
  audio.ts                  # Score source + the audio-reactive hook
  fonts.ts                  # Self-hosted font loading
  scenes/
    01-FirstTouch.tsx  02-Centenario1930.tsx  03-Timeline100.tsx
    04-Globe.tsx       05-NationModule.tsx    11-Stadium.tsx
    12-UnityLockup.tsx
  components/
    HexWipe.tsx        NationCard.tsx     PlayerSilhouette.tsx
    CrowdWave.tsx      GoldParticles.tsx  GrainOverlay.tsx
    TypeLockup.tsx     Motifs.tsx         StreetFootball.tsx
  config/
    nations.ts  players.ts  timeline.ts  theme.ts  geo.ts  layout.ts
  three/
    Stadium.tsx  Globe.tsx
  lib/
    ball.ts                 # Truncated icosahedron for the Shot 12 ball
public/
  brand/  audio/  fonts/
tools/
  make-temp-score.mjs
out/
```

---

## Notes on a few decisions

**The ball is real geometry.** `src/lib/ball.ts` constructs an actual truncated
icosahedron — 12 pentagons, 20 hexagons — from an icosahedron, so it rotates
with correct panel foreshortening and back-face culling rather than being a flat
illustration. The six host outlines genuinely morph into panels via
`interpolatePath`, and stay engraved inside them as the ball turns.

**Uruguay takes the centre pentagon** in the lockup. The tournament opens at the
Estadio Centenario, so the ball is built outward from where it began.

**The 1942 and 1946 gap is deliberate.** Both appear on the timeline rail marked
"not played · the war years". A century of the tournament includes the years it
could not be held.

**The crowd is not segregated by section.** In Shot 11 the instanced crowd draws
its colours from all six national palettes and scatters them through the whole
bowl. That is the shot's argument expressed in the data — one crowd, not six.
Each instance also carries a random phase offset, without which a Mexican wave
reads as a rotating stripe rather than as people.

**Ordinary people are in the payoff shot.** Cut into the stadium sequence on
beats 4, 8 and 12: a Casablanca rooftop, a Montevideo beach, a Lisbon alley, an
Asunción dust pitch — same vector language as the nation modules. Elite football
is the spectacle; this is the game.

**Country outlines are projected from real coordinates**, not hand-drawn, so the
flat outlines in Shots 05–10 and the coastlines on the Shot 04 globe are the
same data and can never disagree.

**Culture motifs are illustrated, never photographic.** Eighteen motifs across
three fixed parallax depths — landscape, architecture, ornament — with the same
depth roles for all six nations. That shared discipline is what stops six nation
modules from looking like six different films.
