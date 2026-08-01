import {useMemo} from 'react';
import {AbsoluteFill, random, useCurrentFrame} from 'remotion';
import {GRAIN_OPACITY} from '../config/theme';

/**
 * 4% film grain across the entire film. Rendered as a tiling fractal-noise
 * SVG whose seed advances every frame, so the grain crawls the way real stock
 * does instead of sitting static and reading as a texture overlay.
 */
export const GrainOverlay: React.FC<{
  opacity?: number;
  /** Larger = coarser grain. */
  scale?: number;
}> = ({opacity = GRAIN_OPACITY, scale = 0.9}) => {
  const frame = useCurrentFrame();
  // Advance the seed on a 3-frame cadence: full 30fps grain flicker reads as
  // digital noise on a broadcast encode.
  const seedFrame = Math.floor(frame / 3);
  const seed = useMemo(() => Math.floor(random(`grain-${seedFrame}`) * 9999), [seedFrame]);

  return (
    <AbsoluteFill
      style={{
        opacity,
        mixBlendMode: 'overlay',
        pointerEvents: 'none',
      }}
    >
      <svg width="100%" height="100%" preserveAspectRatio="none">
        <filter id={`grain-${seed}`} x="0" y="0" width="100%" height="100%">
          <feTurbulence
            type="fractalNoise"
            baseFrequency={scale}
            numOctaves={2}
            seed={seed}
            stitchTiles="stitch"
          />
          <feColorMatrix type="saturate" values="0" />
        </filter>
        <rect width="100%" height="100%" filter={`url(#grain-${seed})`} />
      </svg>
    </AbsoluteFill>
  );
};

/**
 * Vignette + subtle chromatic warmth. Applied once at film level so all twelve
 * shots share the same grade rather than each scene inventing its own.
 */
export const FilmGrade: React.FC<{strength?: number}> = ({strength = 1}) => (
  <AbsoluteFill
    style={{
      pointerEvents: 'none',
      background: `radial-gradient(ellipse at 50% 46%, rgba(0,0,0,0) 38%, rgba(0,0,0,${
        0.42 * strength
      }) 100%)`,
    }}
  />
);
