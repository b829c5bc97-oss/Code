import {continueRender, delayRender, staticFile} from 'remotion';

/**
 * Fonts are self-hosted under `public/fonts/` rather than pulled from Google
 * at render time — a broadcast render must not depend on a network round trip,
 * and a missed font swap would change the type metrics mid-render.
 *
 * SWAP POINT: to move to FIFA's licensed brand faces, drop the woff2 files in
 * `public/fonts/` and edit the table below. `fontStacks` in `config/theme.ts`
 * is the only other place font names appear.
 */

type FaceSpec = {
  family: string;
  file: string;
  weight: string;
  unicodeRange?: string;
};

const FACES: FaceSpec[] = [
  {family: 'Anton', file: 'anton-latin-400.woff2', weight: '400'},
  {
    family: 'Anton',
    file: 'anton-latin-ext-400.woff2',
    weight: '400',
    unicodeRange: 'U+0100-02BA, U+1E00-1EFF, U+2020, U+20A0-20AB, U+2113, U+2C60-2C7F, U+A720-A7FF',
  },
  {family: 'Barlow', file: 'barlow-latin-400.woff2', weight: '400'},
  {family: 'Barlow', file: 'barlow-latin-500.woff2', weight: '500'},
  {family: 'Barlow', file: 'barlow-latin-600.woff2', weight: '600'},
  {family: 'Barlow', file: 'barlow-latin-700.woff2', weight: '700'},
  {
    family: 'Barlow',
    file: 'barlow-latin-ext-500.woff2',
    weight: '500',
    unicodeRange: 'U+0100-02BA, U+1E00-1EFF, U+2020, U+20A0-20AB, U+2113, U+2C60-2C7F, U+A720-A7FF',
  },
  {family: 'Noto Sans Arabic', file: 'notosansarabic-arabic-400.woff2', weight: '400'},
  {family: 'Noto Sans Arabic', file: 'notosansarabic-arabic-700.woff2', weight: '700'},
];

let started = false;

export const loadFonts = (): void => {
  if (started || typeof document === 'undefined') return;
  started = true;

  const handle = delayRender('Loading self-hosted fonts');

  Promise.all(
    FACES.map(async (spec) => {
      const face = new FontFace(spec.family, `url(${staticFile(`fonts/${spec.file}`)}) format('woff2')`, {
        weight: spec.weight,
        style: 'normal',
        ...(spec.unicodeRange ? {unicodeRange: spec.unicodeRange} : {}),
      });
      const loaded = await face.load();
      document.fonts.add(loaded);
    }),
  )
    .then(() => continueRender(handle))
    .catch((err) => {
      // Never let a font failure produce a blank frame — fall back to the
      // stack's system faces and keep rendering.
      // eslint-disable-next-line no-console
      console.warn('Font load failed, falling back to system stack:', err);
      continueRender(handle);
    });
};
