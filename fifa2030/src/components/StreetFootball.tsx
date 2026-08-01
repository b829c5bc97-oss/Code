import {palette} from '../config/theme';

/**
 * The cut inserts: ordinary people playing.
 *
 * These are the point of Shot 11. The bowl, the 22 players and the wave are
 * the spectacle; these four frames are the argument — a rooftop in Casablanca,
 * a beach in Montevideo, an alley in Lisbon, a dust pitch in Asunción. Same
 * vector language as the nation modules, so they read as part of the same film
 * rather than as stock footage cutaways.
 */

export type StreetScene = 'casablanca-roof' | 'montevideo-beach' | 'lisbon-alley' | 'asuncion-dust';

export const STREET_SCENES: {kind: StreetScene; caption: string}[] = [
  {kind: 'casablanca-roof', caption: 'Casablanca · a rooftop'},
  {kind: 'montevideo-beach', caption: 'Montevideo · the beach'},
  {kind: 'lisbon-alley', caption: 'Lisbon · an alley'},
  {kind: 'asuncion-dust', caption: 'Asunción · a dust pitch'},
];

const W = 200;
const H = 100;

/** A small running figure, in the same skeleton language as PlayerSilhouette. */
const Kid: React.FC<{x: number; y: number; s: number; phase: number; color: string}> = ({
  x,
  y,
  s,
  phase,
  color,
}) => {
  const swing = Math.sin(phase) * 6;
  const swing2 = Math.sin(phase + Math.PI) * 6;
  return (
    <g transform={`translate(${x} ${y}) scale(${s})`} stroke={color} fill={color}>
      <circle cx="0" cy="-19" r="3.1" stroke="none" />
      <line x1="0" y1="-16" x2="0" y2="-7" strokeWidth="2.8" strokeLinecap="round" />
      <line x1="0" y1="-14" x2={-5 - swing * 0.4} y2="-9" strokeWidth="2" strokeLinecap="round" />
      <line x1="0" y1="-14" x2={5 + swing2 * 0.4} y2="-10" strokeWidth="2" strokeLinecap="round" />
      <line x1="0" y1="-7" x2={swing} y2="0" strokeWidth="2.4" strokeLinecap="round" />
      <line x1="0" y1="-7" x2={swing2} y2="0" strokeWidth="2.4" strokeLinecap="round" />
    </g>
  );
};

const Setting: React.FC<{kind: StreetScene; t: number}> = ({kind, t}) => {
  const bone = palette.bone;

  if (kind === 'casablanca-roof') {
    return (
      <g>
        {/* Dusk sky first: the rooftops are ink silhouettes and need something
            to be silhouetted against. */}
        <defs>
          <linearGradient id="casaSky" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={palette.atlantic} />
            <stop offset="52%" stopColor="#3B2320" />
            <stop offset="100%" stopColor={palette.terracotta} stopOpacity="0.55" />
          </linearGradient>
        </defs>
        <rect x="-10" y="-10" width={W + 20} height="84" fill="url(#casaSky)" />
        {/* Medina rooftops stepping away, satellite dishes, washing lines. */}
        <rect x="-10" y="72" width={W + 20} height={H} fill={palette.ink} />
        {[0, 26, 54, 84, 116, 150, 180].map((x, i) => (
          <g key={x} fill={palette.ink} opacity={0.95}>
            <rect x={x} y={44 + (i % 3) * 7} width="24" height={H} />
            <rect x={x + 3} y={40 + (i % 3) * 7} width="18" height="4" />
          </g>
        ))}
        {[34, 92, 158].map((x, i) => (
          <g key={x} stroke={bone} opacity={0.45} fill="none">
            <path d={`M${x},${46 + i * 4} a5,5 0 0 1 10,0`} strokeWidth="1" />
            <line x1={x + 5} y1={46 + i * 4} x2={x + 5} y2={52 + i * 4} strokeWidth="0.8" />
          </g>
        ))}
        {/* Washing line sagging between two roofs. */}
        <path d="M28,40 Q80,52 132,42" stroke={bone} strokeWidth="0.7" fill="none" opacity={0.5} />
        <rect x="-10" y="72" width={W + 20} height="1" fill={bone} opacity={0.3} />
      </g>
    );
  }

  if (kind === 'montevideo-beach') {
    return (
      <g>
        {/* Río de la Plata at dusk, the Rambla behind, a goal of two backpacks. */}
        <rect x="-10" y="-10" width={W + 20} height="62" fill={palette.atlantic} opacity={0.35} />
        <rect x="-10" y="52" width={W + 20} height={H} fill={palette.ink} opacity={0.85} />
        {Array.from({length: 5}, (_, i) => (
          <path
            key={i}
            d={`M-10,${56 + i * 3.5} Q${50 + Math.sin(t + i) * 14},${52 + i * 3.5} 210,${56 + i * 3.5}`}
            stroke={bone}
            strokeWidth="0.6"
            fill="none"
            opacity={0.28 - i * 0.04}
          />
        ))}
        {/* Skyline strip on the far bank. */}
        {Array.from({length: 22}, (_, i) => (
          <rect key={i} x={i * 9.5 - 6} y={44 - (i % 4) * 3} width="6" height="9" fill={palette.ink} opacity={0.7} />
        ))}
        {[44, 150].map((x) => (
          <rect key={x} x={x} y="82" width="5" height="6" rx="1.5" fill={bone} opacity={0.6} />
        ))}
      </g>
    );
  }

  if (kind === 'lisbon-alley') {
    return (
      <g>
        {/* A narrow alley in perspective, azulejo walls, laundry overhead. */}
        <rect x="-10" y="-10" width={W + 20} height={H + 20} fill={palette.ink} />
        <path d="M-10,-10 L74,30 L74,84 L-10,110 Z" fill="#0B2036" />
        <path d={`M210,-10 L126,30 L126,84 L210,110 Z`} fill="#0B2036" />
        <path d="M74,30 L126,30 L126,84 L74,84 Z" fill={palette.atlantic} opacity={0.4} />
        {/* Tiled wall hint. */}
        {Array.from({length: 6}, (_, i) => (
          <g key={i} opacity={0.3}>
            <line x1={10 + i * 11} y1={4 + i * 4} x2={10 + i * 11} y2={100 - i * 3} stroke={bone} strokeWidth="0.5" />
            <line x1={190 - i * 11} y1={4 + i * 4} x2={190 - i * 11} y2={100 - i * 3} stroke={bone} strokeWidth="0.5" />
          </g>
        ))}
        {[18, 34, 50].map((y, i) => (
          <path
            key={y}
            d={`M60,${y} Q100,${y + 8 + Math.sin(t + i) * 2} 140,${y}`}
            stroke={bone}
            strokeWidth="0.6"
            fill="none"
            opacity={0.45}
          />
        ))}
        <rect x="-10" y="88" width={W + 20} height={H} fill={palette.ink} />
      </g>
    );
  }

  // asuncion-dust
  return (
    <g>
      <rect x="-10" y="-10" width={W + 20} height="66" fill={palette.terracotta} opacity={0.18} />
      <rect x="-10" y="66" width={W + 20} height={H} fill={palette.terracotta} opacity={0.35} />
      {/* Tree line and a goal made of two branches. */}
      {[12, 40, 168, 192].map((x, i) => (
        <g key={x} fill={palette.ink} opacity={0.8}>
          <rect x={x} y="44" width="2.4" height="24" />
          <circle cx={x + 1.2} cy="42" r={7 + (i % 2) * 2} />
        </g>
      ))}
      {/* Dust kicked up along the ground. */}
      {Array.from({length: 9}, (_, i) => (
        <ellipse
          key={i}
          cx={30 + i * 18 + Math.sin(t * 2 + i) * 5}
          cy={88}
          rx={7 + (i % 3) * 3}
          ry="2.2"
          fill={palette.bone}
          opacity={0.09}
        />
      ))}
      <g stroke={palette.ink} strokeWidth="1.6" opacity={0.8}>
        <line x1="132" y1="46" x2="132" y2="76" />
        <line x1="166" y1="46" x2="166" y2="76" />
        <line x1="132" y1="46" x2="166" y2="46" />
      </g>
      <rect x="-10" y="66" width={W + 20} height="0.8" fill={palette.bone} opacity={0.25} />
    </g>
  );
};

const FIGURES: Record<StreetScene, {x: number; y: number; s: number}[]> = {
  'casablanca-roof': [
    {x: 62, y: 72, s: 1.1},
    {x: 96, y: 72, s: 1.25},
    {x: 132, y: 72, s: 0.95},
  ],
  'montevideo-beach': [
    {x: 58, y: 88, s: 1.2},
    {x: 100, y: 86, s: 1.35},
    {x: 138, y: 88, s: 1.05},
    {x: 172, y: 86, s: 0.9},
  ],
  'lisbon-alley': [
    {x: 86, y: 88, s: 1.5},
    {x: 112, y: 86, s: 1.2},
  ],
  'asuncion-dust': [
    {x: 52, y: 88, s: 1.25},
    {x: 88, y: 88, s: 1.4},
    {x: 118, y: 86, s: 1.1},
  ],
};

const BALL: Record<StreetScene, [number, number]> = {
  'casablanca-roof': [114, 68],
  'montevideo-beach': [120, 84],
  'lisbon-alley': [100, 85],
  'asuncion-dust': [104, 85],
};

export const StreetFootball: React.FC<{
  kind: StreetScene;
  /** Seconds, for the small internal motion. */
  t: number;
}> = ({kind, t}) => {
  const figures = FIGURES[kind];
  const ball = BALL[kind];

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height="100%" preserveAspectRatio="xMidYMid slice">
      {/* Opaque base. These are cuts, not overlays — without this the stadium
          shows through and the insert reads as a double exposure. */}
      <rect x="-10" y="-10" width={W + 20} height={H + 20} fill={palette.ink} />
      <Setting kind={kind} t={t} />
      {figures.map((f, i) => (
        <Kid key={i} x={f.x} y={f.y} s={f.s} phase={t * 6 + i * 1.9} color={palette.bone} />
      ))}
      <circle cx={ball[0] + Math.sin(t * 4) * 4} cy={ball[1]} r="2.6" fill={palette.goldLight} />
    </svg>
  );
};
