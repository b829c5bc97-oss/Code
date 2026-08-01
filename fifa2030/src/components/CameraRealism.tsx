import {AbsoluteFill, random, useCurrentFrame} from 'remotion';
import {useLayout} from '../config/layout';
import {palette} from '../config/theme';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  CAMERA REALISM
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Everything in this film up to now is optically perfect: locked-off CG,
 * vector linework, no lens in the way. That reads as CLEAN, not REAL — a real
 * broadcast camera drifts a little even on a "locked" shot, catches a flare
 * off anything bright, and fringes colour at high-contrast edges during fast
 * motion. These three primitives are that imperfection, applied deliberately
 * rather than left to a filter preset.
 */

/**
 * Handheld drift for the whole film — wraps the master composition, not
 * individual shots. A shake applied per-shot reads as twelve different
 * cameras; one continuous low-frequency drift reads as one operator holding
 * one camera through the whole sequence.
 *
 * Built from a few offset, slowly-shifting sine waves rather than per-frame
 * random noise — true noise jitters every frame and reads as sensor grain,
 * not as a hand. A real operator's drift has continuity: it curves.
 */
export const HandheldDrift: React.FC<{children: React.ReactNode; strength?: number}> = ({
  children,
  strength = 1,
}) => {
  const frame = useCurrentFrame();
  const t = frame / 30;

  const x =
    (Math.sin(t * 0.34) * 1.4 + Math.sin(t * 0.87 + 1.3) * 0.6) * strength;
  const y =
    (Math.sin(t * 0.41 + 0.7) * 1.1 + Math.sin(t * 1.03 + 2.1) * 0.45) * strength;
  const rot = (Math.sin(t * 0.23 + 2.4) * 0.14 + Math.sin(t * 0.61) * 0.06) * strength;
  // A slow, barely-perceptible scale breathing — a held shot is never
  // perfectly static even at a fixed focal length.
  const scale = 1 + (Math.sin(t * 0.19) * 0.0035) * strength;

  return (
    <AbsoluteFill
      style={{
        transform: `translate(${x}px, ${y}px) rotate(${rot}deg) scale(${scale})`,
        transformOrigin: '50% 50%',
      }}
    >
      {children}
    </AbsoluteFill>
  );
};

/**
 * A lens flare: a bright core, an anamorphic horizontal streak, and a string
 * of ghost rings tracking back through frame centre — the classic signature of
 * a strong point light hitting a real lens, not a raster asset.
 *
 * `strength` should be driven by something diegetic (the gold burst's own
 * intensity, the specular sweep's proximity) so the flare arrives WITH the
 * light rather than as a decoration sitting on top of it.
 */
export const LensFlare: React.FC<{
  /** Fraction of frame, 0-1. */
  origin: {x: number; y: number};
  strength: number;
  color?: string;
  /** Anamorphic streak length, in layout units. */
  streak?: number;
}> = ({origin, strength, color = palette.goldLight, streak = 46}) => {
  const {u, width, height} = useLayout();
  if (strength <= 0.01) return null;

  const cx = origin.x * width;
  const cy = origin.y * height;
  // Ghosts track the line from the light, through frame centre, and out the
  // far side — where a real flare's internal reflections fall.
  const dx = width / 2 - cx;
  const dy = height / 2 - cy;

  const ghosts = [-0.4, 0.3, 0.75, 1.3, 1.9, 2.6];

  return (
    <AbsoluteFill style={{pointerEvents: 'none', mixBlendMode: 'screen'}}>
      <svg width={width} height={height} style={{position: 'absolute', inset: 0}}>
        <defs>
          <radialGradient id="flareCore" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#ffffff" stopOpacity={0.95} />
            <stop offset="30%" stopColor={color} stopOpacity={0.6} />
            <stop offset="100%" stopColor={color} stopOpacity={0} />
          </radialGradient>
          <linearGradient id="flareStreak" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor={color} stopOpacity={0} />
            <stop offset="48%" stopColor={color} stopOpacity={0.55 * strength} />
            <stop offset="52%" stopColor="#ffffff" stopOpacity={0.7 * strength} />
            <stop offset="100%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>

        {/* Anamorphic horizontal streak through the source. */}
        <rect
          x={cx - u(streak)}
          y={cy - u(0.16)}
          width={u(streak * 2)}
          height={u(0.32)}
          fill="url(#flareStreak)"
        />

        {/* Ghost reflections along the light-to-centre axis. */}
        {ghosts.map((g, i) => {
          const gx = cx + dx * g;
          const gy = cy + dy * g;
          const r = u((1.4 + Math.abs(Math.sin(i * 2.1)) * 2.6) * (1 - Math.abs(g - 0.9) * 0.15));
          return (
            <circle
              key={i}
              cx={gx}
              cy={gy}
              r={Math.max(u(0.3), r)}
              fill={i % 2 ? color : '#ffffff'}
              opacity={strength * (0.14 + (i % 3) * 0.05)}
            />
          );
        })}

        {/* The core. */}
        <circle cx={cx} cy={cy} r={u(7)} fill="url(#flareCore)" opacity={strength} />
      </svg>
    </AbsoluteFill>
  );
};

/**
 * Chromatic aberration: the red and blue channels split outward from frame
 * centre. Reserved for fast motion (wipes, the shockwave, whip pans) — applied
 * across the whole film it reads as a found-footage gimmick; applied only at
 * the instant something moves violently, it reads as a lens under stress,
 * which is when a real one actually does this.
 */
export const ChromaticAberration: React.FC<{children: React.ReactNode; strength: number}> = ({
  children,
  strength,
}) => {
  if (strength <= 0.01) return <>{children}</>;
  const px = strength * 3.2;

  return (
    <AbsoluteFill>
      <AbsoluteFill
        style={{
          transform: `translateX(${-px}px)`,
          mixBlendMode: 'screen',
          filter: 'url(#caRedOnly)',
        }}
      >
        {children}
      </AbsoluteFill>
      <AbsoluteFill
        style={{
          transform: `translateX(${px}px)`,
          mixBlendMode: 'screen',
          filter: 'url(#caBlueOnly)',
        }}
      >
        {children}
      </AbsoluteFill>
      <AbsoluteFill style={{mixBlendMode: 'screen', filter: 'url(#caGreenOnly)'}}>
        {children}
      </AbsoluteFill>
      <svg width={0} height={0} style={{position: 'absolute'}}>
        <defs>
          <filter id="caRedOnly">
            <feColorMatrix
              type="matrix"
              values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0"
            />
          </filter>
          <filter id="caGreenOnly">
            <feColorMatrix
              type="matrix"
              values="0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0"
            />
          </filter>
          <filter id="caBlueOnly">
            <feColorMatrix
              type="matrix"
              values="0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0"
            />
          </filter>
        </defs>
      </svg>
    </AbsoluteFill>
  );
};

/**
 * Fine, fast-moving dust and atmospheric haze — the particulate a real lens
 * always has a little of in a large, lit volume. Distinct from `GrainOverlay`,
 * which is sensor/film texture sitting ON the image; this sits believably
 * IN the space the camera is looking at.
 */
export const AtmosphereDust: React.FC<{density?: number; opacity?: number}> = ({
  density = 34,
  opacity = 0.5,
}) => {
  const frame = useCurrentFrame();
  const {width, height, u} = useLayout();
  const t = frame / 30;

  return (
    <AbsoluteFill style={{pointerEvents: 'none', mixBlendMode: 'screen'}}>
      <svg width={width} height={height} style={{position: 'absolute', inset: 0}}>
        {Array.from({length: density}, (_, i) => {
          const seedX = random(`ad-x-${i}`);
          const seedY = random(`ad-y-${i}`);
          const speed = 0.02 + random(`ad-s-${i}`) * 0.05;
          const drift = (t * speed + seedX) % 1.15;
          const x = drift * width;
          const y = ((seedY + Math.sin(t * 0.1 + i) * 0.02) % 1) * height;
          const r = u(0.06 + random(`ad-r-${i}`) * 0.14);
          const flicker = 0.4 + Math.sin(t * 2 + i * 3) * 0.3;
          return (
            <circle
              key={i}
              cx={x}
              cy={y}
              r={r}
              fill={palette.bone}
              opacity={opacity * flicker * (1 - Math.abs(drift - 0.5) * 0.3)}
            />
          );
        })}
      </svg>
    </AbsoluteFill>
  );
};
