import {useMemo} from 'react';
import {AbsoluteFill, Easing, interpolate, random, useCurrentFrame} from 'remotion';
import {useLayout} from '../config/layout';
import {palette} from '../config/theme';

/**
 * The film's signature transition: the panel grid of a football sweeping
 * across the frame.
 *
 * Hexagons and pentagons on a honeycomb lattice flip in along a diagonal
 * wavefront, hold the frame for a beat, then flip out — so the cut lands
 * inside the wipe rather than beside it.
 *
 * `direction` lets continent-to-continent jumps sweep the way the film is
 * travelling, which is why Shot 04's dive into Morocco and the Atlantic
 * crossing don't wipe the same way.
 */

type Props = {
  /** Frame the wipe starts on, relative to the enclosing Sequence. */
  startFrame: number;
  /** Total length of the sweep. Half covers, half uncovers. */
  duration?: number;
  color?: string;
  accent?: string;
  direction?: 'left' | 'right' | 'up' | 'down';
  /** Cell size in layout units. */
  cell?: number;
  /** Cover only (no uncover) — used when the next shot reveals underneath. */
  coverOnly?: boolean;
};

const hexPoints = (r: number): string =>
  Array.from({length: 6}, (_, i) => {
    const a = (i * Math.PI) / 3 - Math.PI / 6;
    return `${(Math.cos(a) * r).toFixed(2)},${(Math.sin(a) * r).toFixed(2)}`;
  }).join(' ');

const pentPoints = (r: number): string =>
  Array.from({length: 5}, (_, i) => {
    const a = (i * 2 * Math.PI) / 5 - Math.PI / 2;
    return `${(Math.cos(a) * r).toFixed(2)},${(Math.sin(a) * r).toFixed(2)}`;
  }).join(' ');

export const HexWipe: React.FC<Props> = ({
  startFrame,
  duration = 30,
  color = palette.ink,
  accent = palette.goldTrophy,
  direction = 'left',
  cell = 9,
  coverOnly = false,
}) => {
  const frame = useCurrentFrame();
  const {u, width, height} = useLayout();

  const r = u(cell);
  const stepX = r * Math.sqrt(3);
  const stepY = r * 1.5;
  const cols = Math.ceil(width / stepX) + 3;
  const rows = Math.ceil(height / stepY) + 3;

  const cells = useMemo(() => {
    const out: {x: number; y: number; wave: number; pent: boolean; jitter: number}[] = [];
    for (let row = -1; row < rows; row++) {
      for (let col = -1; col < cols; col++) {
        const x = col * stepX + (row % 2 ? stepX / 2 : 0);
        const y = row * stepY;
        const nx = x / width;
        const ny = y / height;
        const wave =
          direction === 'left'
            ? 1 - nx
            : direction === 'right'
              ? nx
              : direction === 'up'
                ? 1 - ny
                : ny;
        out.push({
          x,
          y,
          // Slight diagonal bias so the wavefront isn't a flat vertical line.
          wave: wave * 0.86 + (direction === 'left' || direction === 'right' ? ny : nx) * 0.14,
          pent: random(`pent-${row}-${col}`) > 0.82,
          jitter: random(`jit-${row}-${col}`) * 0.06,
        });
      }
    }
    return out;
  }, [cols, rows, stepX, stepY, width, height, direction]);

  const local = frame - startFrame;
  const coverEnd = coverOnly ? duration : duration / 2;
  if (local < 0 || local > duration + 1) return null;

  return (
    <AbsoluteFill style={{pointerEvents: 'none'}}>
      <svg width={width} height={height} style={{position: 'absolute', inset: 0}}>
        {cells.map((c, i) => {
          // Each cell covers as the wavefront passes it, then uncovers.
          const onset = (c.wave + c.jitter) * coverEnd * 0.72;
          const cover = interpolate(local, [onset, onset + coverEnd * 0.34], [0, 1], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
            easing: Easing.bezier(0.3, 0, 0.2, 1),
          });
          const uncover = coverOnly
            ? 0
            : interpolate(
                local,
                [coverEnd + onset * 0.5, coverEnd + onset * 0.5 + coverEnd * 0.4],
                [0, 1],
                {
                  extrapolateLeft: 'clamp',
                  extrapolateRight: 'clamp',
                  easing: Easing.bezier(0.4, 0, 0.1, 1),
                },
              );

          const scale = Math.max(0, cover - uncover);
          if (scale <= 0.001) return null;

          return (
            <g key={i} transform={`translate(${c.x} ${c.y}) scale(${scale}) rotate(${(1 - scale) * 40})`}>
              <polygon
                points={c.pent ? pentPoints(r * 1.02) : hexPoints(r * 1.02)}
                fill={c.pent ? palette.pitchDeep : color}
              />
              <polygon
                points={c.pent ? pentPoints(r * 1.02) : hexPoints(r * 1.02)}
                fill="none"
                stroke={accent}
                strokeWidth={u(0.12)}
                opacity={0.4 * scale}
              />
            </g>
          );
        })}
      </svg>
    </AbsoluteFill>
  );
};

/**
 * Whip pan with motion blur — the secondary transition, reserved for
 * continent-to-continent jumps. Applied by the parent to whatever it wraps.
 */
export const WhipPan: React.FC<{
  startFrame: number;
  duration?: number;
  direction?: 'left' | 'right';
  children: React.ReactNode;
}> = ({startFrame, duration = 12, direction = 'left', children}) => {
  const frame = useCurrentFrame();
  const {width} = useLayout();
  const local = frame - startFrame;

  const t = interpolate(local, [0, duration], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.bezier(0.7, 0, 0.3, 1),
  });
  // Velocity peaks mid-pan; blur follows velocity, not position.
  const velocity = Math.sin(t * Math.PI);
  const sign = direction === 'left' ? -1 : 1;

  return (
    <AbsoluteFill
      style={{
        transform: `translateX(${sign * t * width * 0.18}px)`,
        filter: `blur(${velocity * 22}px)`,
        opacity: 1 - velocity * 0.25,
      }}
    >
      {children}
    </AbsoluteFill>
  );
};
