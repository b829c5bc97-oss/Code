import {useMemo} from 'react';
import {AbsoluteFill, random} from 'remotion';
import {useLayout} from '../config/layout';
import {palette} from '../config/theme';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  FIREWORKS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Simulated rather than drawn. Each shell has a launch, an apex, a burst and a
 * fall, and each spark inside a burst is a real ballistic particle with
 * velocity, air drag and gravity. That matters because the thing that makes
 * fireworks read as fireworks is not the shape of the burst — it is the
 * DECELERATION. A spark leaves the shell fast, is slowed hard by drag within
 * a few frames, and only then starts to fall. Radiating particles at constant
 * speed looks like a starburst graphic; this looks like pyrotechnics.
 *
 * Everything is a pure function of the frame, so it renders identically on
 * every pass with no simulation state to drift.
 */

export type ShellType =
  /** Classic sphere of sparks. */
  | 'peony'
  /** Long drooping golden trails. */
  | 'willow'
  /** Fast, tight, with a secondary crackle. */
  | 'crackle';

export type Shell = {
  /** Frame the shell launches, relative to the enclosing Sequence. */
  launch: number;
  /** Burst position as a fraction of the frame. */
  x: number;
  y: number;
  color: string;
  type?: ShellType;
  /** Multiplies spark count and radius. */
  scale?: number;
};

const RISE = 26; // frames from launch to burst

/** Drag-integrated displacement: fast out, decelerating hard. */
const travel = (v: number, t: number, drag: number) =>
  (v * (1 - Math.exp(-drag * t))) / drag;

const SparkBurst: React.FC<{
  shell: Shell;
  age: number;
  index: number;
}> = ({shell, age, index}) => {
  const {u, width, height} = useLayout();
  const type = shell.type ?? 'peony';
  const scale = shell.scale ?? 1;

  const count = Math.round((type === 'willow' ? 74 : type === 'crackle' ? 96 : 110) * scale);
  const life = type === 'willow' ? 88 : type === 'crackle' ? 46 : 66;
  if (age < 0 || age > life * 1.25) return null;

  const cx = shell.x * width;
  const cy = shell.y * height;
  const drag = type === 'willow' ? 2.6 : 3.4;
  const gravity = type === 'willow' ? 74 : 46;

  return (
    <g>
      {Array.from({length: count}, (_, i) => {
        const seed = `fw-${index}-${i}`;
        // Even spherical distribution, projected — a flat random angle
        // clusters visibly at the poles once you have a hundred sparks.
        const theta = random(`${seed}-a`) * Math.PI * 2;
        const phi = Math.acos(2 * random(`${seed}-b`) - 1);
        const speedJitter = 0.55 + random(`${seed}-s`) ** 0.6 * 0.85;

        const vx = Math.sin(phi) * Math.cos(theta) * speedJitter;
        const vy = Math.cos(phi) * speedJitter;

        const t = age / 30;
        const sparkLife = life * (0.6 + random(`${seed}-l`) * 0.6);
        const norm = age / sparkLife;
        if (norm > 1) return null;

        const reach = u(34) * scale;
        const px = cx + travel(vx * reach, t, drag);
        const py =
          cy + travel(vy * reach, t, drag) + 0.5 * gravity * t * t * (type === 'willow' ? 1.5 : 1);

        // Sparks burn white-hot, then cool to the shell's colour, then die.
        const heat = Math.max(0, 1 - norm * 3.2);
        const fill = heat > 0.5 ? '#FFFFFF' : shell.color;

        // Twinkle: real sparks flicker as they tumble.
        const twinkle =
          type === 'crackle'
            ? 0.45 + 0.55 * Math.abs(Math.sin(age * 0.9 + i * 2.3))
            : 0.75 + 0.25 * Math.sin(age * 0.4 + i);

        const fade = Math.min(1, (1 - norm) * 2.4);
        const r = u(0.16 + random(`${seed}-r`) * 0.2) * scale * (0.5 + heat * 0.8);

        // Short motion trail behind each spark, drawn one step back along its
        // own path — this is most of what gives a burst its silky look.
        const tPrev = Math.max(0, (age - 3) / 30);
        const pxPrev = cx + travel(vx * reach, tPrev, drag);
        const pyPrev =
          cy +
          travel(vy * reach, tPrev, drag) +
          0.5 * gravity * tPrev * tPrev * (type === 'willow' ? 1.5 : 1);

        return (
          <g key={i} opacity={fade * twinkle}>
            <line
              x1={pxPrev}
              y1={pyPrev}
              x2={px}
              y2={py}
              stroke={fill}
              strokeWidth={r * 1.3}
              strokeLinecap="round"
              opacity={0.5}
            />
            <circle cx={px} cy={py} r={r} fill={fill} />
          </g>
        );
      })}
    </g>
  );
};

const Rocket: React.FC<{shell: Shell; age: number}> = ({shell, age}) => {
  const {u, width, height} = useLayout();
  if (age < 0 || age > RISE) return null;

  const p = age / RISE;
  // Decelerating rise — a shell is slowest at apex, which is where it bursts.
  const eased = 1 - Math.pow(1 - p, 1.9);
  const cx = shell.x * width;
  const cy = shell.y * height;
  const x = cx + (1 - eased) * u(3) * (shell.x < 0.5 ? 1 : -1);
  const y = height * 1.02 + (cy - height * 1.02) * eased;

  return (
    <g opacity={0.9}>
      <line
        x1={x}
        y1={y + u(4.5)}
        x2={x}
        y2={y}
        stroke={palette.goldLight}
        strokeWidth={u(0.16)}
        strokeLinecap="round"
        opacity={0.35}
      />
      <circle cx={x} cy={y} r={u(0.3)} fill="#FFFFFF" />
    </g>
  );
};

export const Fireworks: React.FC<{
  shells: Shell[];
  /** Current frame, relative to the enclosing Sequence. */
  frame: number;
  /** Master opacity. */
  opacity?: number;
  glow?: boolean;
}> = ({shells, frame, opacity = 1, glow = true}) => {
  const {u, width, height} = useLayout();

  // Only shells that are actually on screen — the film has dozens across the
  // finale and simulating all of them every frame is pure waste.
  const active = useMemo(
    () =>
      shells
        .map((shell, index) => ({shell, index}))
        .filter(({shell}) => frame >= shell.launch && frame <= shell.launch + RISE + 115),
    [shells, frame],
  );

  if (!active.length) return null;

  return (
    <AbsoluteFill style={{pointerEvents: 'none', mixBlendMode: 'screen', opacity}}>
      <svg width={width} height={height} style={{position: 'absolute', inset: 0}}>
        {glow ? (
          <defs>
            <filter id="fwGlow" x="-30%" y="-30%" width="160%" height="160%">
              <feGaussianBlur stdDeviation={u(0.42)} result="b" />
              <feMerge>
                <feMergeNode in="b" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>
        ) : null}
        <g filter={glow ? 'url(#fwGlow)' : undefined}>
          {active.map(({shell, index}) => (
            <g key={index}>
              <Rocket shell={shell} age={frame - shell.launch} />
              <SparkBurst shell={shell} age={frame - shell.launch - RISE} index={index} />
            </g>
          ))}
        </g>
      </svg>
    </AbsoluteFill>
  );
};

/**
 * Builds a barrage: shells staggered across a window, positions and colours
 * spread so no two neighbouring bursts read as a pair.
 */
export const buildBarrage = (opts: {
  start: number;
  count: number;
  /** Frames between launches. */
  stagger: number;
  colors?: string[];
  seed?: string;
  /** Vertical band the bursts occupy, as frame fractions. */
  yRange?: [number, number];
  scale?: number;
}): Shell[] => {
  const {
    start,
    count,
    stagger,
    colors = [palette.goldTrophy, palette.goldLight, palette.bone, '#5FA8E8', '#E85F5F'],
    seed = 'barrage',
    yRange = [0.14, 0.46],
    scale = 1,
  } = opts;

  const types: ShellType[] = ['peony', 'peony', 'willow', 'crackle'];

  return Array.from({length: count}, (_, i) => {
    const r = (k: string) => random(`${seed}-${i}-${k}`);
    return {
      launch: Math.round(start + i * stagger + (r('j') - 0.5) * stagger * 0.7),
      // Alternate sides so the barrage fills the frame instead of clumping.
      x: 0.1 + ((i % 2 === 0 ? r('x') * 0.42 : 0.48 + r('x') * 0.42)),
      y: yRange[0] + r('y') * (yRange[1] - yRange[0]),
      color: colors[Math.floor(r('c') * colors.length)] ?? palette.goldTrophy,
      type: types[Math.floor(r('t') * types.length)],
      scale: scale * (0.75 + r('s') * 0.6),
    };
  });
};
