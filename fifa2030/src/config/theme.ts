/**
 * Single source of truth for palette, type scale and motion.
 *
 * Gold (`goldTrophy` / `goldLight`) is reserved for centenary moments only —
 * the 100 mark, the trophy, the year cards, the final lockup. Do not reach for
 * it as decorative filler.
 */

export const palette = {
  pitchDeep: '#0A1F14',
  goldTrophy: '#D4A73C',
  goldLight: '#F2D998',
  atlantic: '#0B3B5C',
  terracotta: '#C1502E',
  bone: '#F4EFE6',
  ink: '#050B08',
} as const;

export type PaletteKey = keyof typeof palette;

/** Musical grid: 120 BPM at 30fps = one beat every 15 frames. */
export const BPM = 120;
export const FPS = 30;
export const FRAMES_PER_BEAT = (60 / BPM) * FPS; // 15
export const FRAMES_PER_BAR = FRAMES_PER_BEAT * 4; // 60

/** Frame of the nth beat from the start of the film. */
export const beat = (n: number) => Math.round(n * FRAMES_PER_BEAT);

/** Total film length. 90s @ 30fps. */
export const TOTAL_FRAMES = 2700;

/**
 * Type scale is expressed in viewport-min units (`vmin`-like), never pixels, so
 * the same components lay out correctly at 16:9, 9:16 and 1:1.
 */
export const typeScale = {
  hero: 16,
  display: 11,
  title: 7.5,
  subtitle: 3.6,
  body: 2.6,
  caption: 1.9,
  micro: 1.5,
} as const;

export const fontStacks = {
  display: '"Anton", "Archivo", "Arial Narrow", sans-serif',
  body: '"Barlow", "Inter", system-ui, sans-serif',
  /** Arabic-capable stack for المغرب. */
  arabic: '"Noto Sans Arabic", "Barlow", system-ui, sans-serif',
} as const;

/** Shared spring vocabulary. Nothing in this film uses a linear tween except
 *  constant camera drifts and the timeline rail. */
export const springs = {
  /** Heavy, authoritative — logo lockups, year slams. */
  slam: {damping: 200, mass: 1.1, stiffness: 190} as const,
  /** Standard UI-ish entrance for type. */
  type: {damping: 200, mass: 0.6, stiffness: 120} as const,
  /** Soft settle for large graphic elements. */
  settle: {damping: 200, mass: 1.4, stiffness: 70} as const,
  /** Snappy, used for wipes and panel grids. */
  snap: {damping: 26, mass: 0.5, stiffness: 220} as const,
  /** Slight overshoot for celebratory beats. */
  pop: {damping: 12, mass: 0.7, stiffness: 200} as const,
} as const;

/** Global grain opacity — applied once across the whole film. */
export const GRAIN_OPACITY = 0.04;

export const letterspacing = {
  tight: '-0.02em',
  normal: '0em',
  wide: '0.14em',
  ultra: '0.34em',
} as const;
