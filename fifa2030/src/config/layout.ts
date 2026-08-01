import {useVideoConfig} from 'remotion';

export type Format = 'landscape' | 'square' | 'portrait';

export type Layout = {
  width: number;
  height: number;
  aspect: number;
  format: Format;
  isPortrait: boolean;
  isSquare: boolean;
  isLandscape: boolean;
  /**
   * Layout unit — 1/100th of the shorter frame edge. Use for spacing, stroke
   * widths, graphic sizes. Identical across all three deliverable formats
   * because they all share a 1080px short edge.
   */
  u: (n: number) => number;
  /**
   * Type unit — width-aware, so a headline sized for 16:9 doesn't overflow the
   * 9:16 and 1:1 frames. Always use this for font sizes.
   */
  t: (n: number) => number;
  /** Pick a value per format without branching at every call site. */
  pick: <T>(values: {landscape: T; portrait?: T; square?: T}) => T;
};

export const useLayout = (): Layout => {
  const {width, height} = useVideoConfig();
  const aspect = width / height;
  const format: Format = aspect > 1.15 ? 'landscape' : aspect < 0.87 ? 'portrait' : 'square';

  const unit = Math.min(width, height) / 100;
  // Constrain type by width as well as height: 4:3 is the widest box a line of
  // display type is allowed to assume before it starts scaling down.
  const typeUnit = Math.min(height, width * 0.75) / 100;

  return {
    width,
    height,
    aspect,
    format,
    isPortrait: format === 'portrait',
    isSquare: format === 'square',
    isLandscape: format === 'landscape',
    u: (n: number) => n * unit,
    t: (n: number) => n * typeUnit,
    pick: <T,>(values: {landscape: T; portrait?: T; square?: T}): T => {
      if (format === 'portrait' && values.portrait !== undefined) return values.portrait;
      if (format === 'square' && values.square !== undefined) return values.square;
      return values.landscape;
    },
  };
};
