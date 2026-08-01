import {useMemo} from 'react';
import {AbsoluteFill, interpolate, random, useCurrentFrame, useVideoConfig} from 'remotion';
import {useLayout} from '../config/layout';
import {palette} from '../config/theme';

type Props = {
  /** Frame the burst is triggered on, relative to the enclosing Sequence. */
  triggerFrame: number;
  count?: number;
  /** Origin as a fraction of the frame. */
  origin?: {x: number; y: number};
  /** Multiplied into the burst radius — drive this from audio amplitude. */
  intensity?: number;
  /** How far particles travel, in layout units. */
  spread?: number;
  colors?: string[];
  /** Gravity pulls particles down after the initial radial impulse. */
  gravity?: number;
  lifetime?: number;
};

/**
 * Radial burst of gold sparks. Used for the first touch in Shot 01 and the
 * lockup settle in Shot 12.
 *
 * `intensity` is deliberately an input rather than a constant: Shot 01 drives
 * it from the score's actual amplitude via `visualizeAudio`, so the burst
 * scale is locked to the sound rather than approximating it.
 */
export const GoldParticles: React.FC<Props> = ({
  triggerFrame,
  count = 140,
  origin = {x: 0.5, y: 0.5},
  intensity = 1,
  spread = 46,
  colors = [palette.goldTrophy, palette.goldLight, palette.bone],
  gravity = 0.32,
  lifetime = 70,
}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const {u, width, height} = useLayout();

  const particles = useMemo(
    () =>
      Array.from({length: count}, (_, i) => {
        const angle = random(`ang-${i}`) * Math.PI * 2;
        // Bias the burst slightly horizontal — a shockwave along the ground
        // plane reads better than a perfect circle.
        const squash = 0.62 + random(`sq-${i}`) * 0.5;
        return {
          angle,
          squash,
          velocity: 0.35 + random(`vel-${i}`) ** 1.6 * 1.3,
          size: 0.16 + random(`sz-${i}`) ** 2 * 0.72,
          delay: random(`dly-${i}`) * 6,
          life: lifetime * (0.55 + random(`lf-${i}`) * 0.7),
          color: colors[Math.floor(random(`col-${i}`) * colors.length)] ?? palette.goldTrophy,
          drift: (random(`dr-${i}`) - 0.5) * 0.5,
        };
      }),
    [count, colors, lifetime],
  );

  const local = frame - triggerFrame;
  if (local < 0 || local > lifetime * 1.9) return null;

  const cx = origin.x * width;
  const cy = origin.y * height;

  return (
    <AbsoluteFill style={{pointerEvents: 'none', mixBlendMode: 'screen'}}>
      <svg width={width} height={height} style={{position: 'absolute', inset: 0}}>
        {particles.map((p, i) => {
          const age = local - p.delay;
          if (age < 0 || age > p.life) return null;
          const norm = age / p.life;

          // Ease-out radial travel, then gravity takes over.
          const travel = (1 - Math.pow(1 - norm, 2.4)) * u(spread) * p.velocity * intensity;
          const t = age / fps;
          const x = cx + Math.cos(p.angle) * travel + p.drift * travel;
          const y =
            cy +
            Math.sin(p.angle) * travel * p.squash +
            gravity * u(26) * t * t * intensity;

          const opacity = interpolate(norm, [0, 0.12, 0.7, 1], [0, 1, 0.85, 0], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
          });
          const r = u(p.size) * (1 - norm * 0.45) * Math.max(0.4, intensity);

          return <circle key={i} cx={x} cy={y} r={r} fill={p.color} opacity={opacity} />;
        })}
      </svg>
    </AbsoluteFill>
  );
};

/**
 * The expanding ring that accompanies the burst — a single shockwave stroke
 * rather than more particles, so the moment reads as one impact.
 */
export const Shockwave: React.FC<{
  triggerFrame: number;
  origin?: {x: number; y: number};
  intensity?: number;
  color?: string;
  duration?: number;
  maxRadius?: number;
}> = ({
  triggerFrame,
  origin = {x: 0.5, y: 0.5},
  intensity = 1,
  color = palette.goldTrophy,
  duration = 46,
  maxRadius = 58,
}) => {
  const frame = useCurrentFrame();
  const {u, width, height} = useLayout();
  const local = frame - triggerFrame;
  if (local < 0 || local > duration) return null;

  const norm = local / duration;
  const radius = (1 - Math.pow(1 - norm, 3)) * u(maxRadius) * intensity;
  const opacity = interpolate(norm, [0, 0.1, 1], [0, 0.9, 0]);

  return (
    <AbsoluteFill style={{pointerEvents: 'none', mixBlendMode: 'screen'}}>
      <svg width={width} height={height} style={{position: 'absolute', inset: 0}}>
        <ellipse
          cx={origin.x * width}
          cy={origin.y * height}
          rx={radius}
          ry={radius * 0.34}
          fill="none"
          stroke={color}
          strokeWidth={u(0.5) * (1 - norm)}
          opacity={opacity}
        />
        <ellipse
          cx={origin.x * width}
          cy={origin.y * height}
          rx={radius * 0.62}
          ry={radius * 0.21}
          fill="none"
          stroke={color}
          strokeWidth={u(0.3) * (1 - norm)}
          opacity={opacity * 0.6}
        />
      </svg>
    </AbsoluteFill>
  );
};
