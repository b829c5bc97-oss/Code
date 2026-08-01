import {useMemo} from 'react';
import {random} from 'remotion';
import type {MotifKind} from '../config/nations';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  CULTURE MOTIFS — one graphic language, eighteen motifs
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Every motif is drawn, not photographed, and every one obeys the same rules:
 *   · flat vector shapes plus hairline ornament, no gradients, no texture maps
 *   · one silhouette mass per layer, so it reads at broadcast distance
 *   · a common 200 × 100 drawing box, so the parallax layers stack predictably
 *
 * That shared discipline is what stops six nation modules from looking like
 * six different films.
 *
 * Depth roles are fixed across all six nations:
 *   far  → landscape / horizon
 *   mid  → architecture or a human figure
 *   near → ornament, tessellating in the foreground
 */

export const MOTIF_W = 200;
export const MOTIF_H = 100;

type MotifProps = {
  kind: MotifKind;
  /** Silhouette mass fill. */
  color: string;
  /** Secondary national colour, for accents. */
  accent: string;
  /** Hairline / linework colour. */
  line: string;
  /** 0 → 1 across the montage; drives draw-on and internal animation. */
  progress: number;
  /** Unique per instance so pattern ids never collide across layers. */
  uid: string;
  /**
   * Tiling density for the pattern-based ornaments. The near layer covers the
   * whole frame, so it has to tile finely enough to read as texture rather
   * than as giant wallpaper.
   */
  density?: number;
};

const ridge = (peaks: [number, number][], baseline = MOTIF_H): string => {
  const pts = peaks.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x},${y}`).join(' ');
  return `M-10,${baseline} ${pts} L${MOTIF_W + 10},${baseline} Z`.replace('M-10', 'M-10');
};

// ─── FAR: landscape and horizon ─────────────────────────────────────────────

const AtlasRidge: React.FC<MotifProps> = ({color, line, accent}) => (
  <g>
    <path
      d={ridge([
        [-10, 74], [14, 52], [30, 62], [48, 34], [62, 50], [76, 40],
        [94, 58], [112, 30], [128, 48], [146, 38], [166, 58], [186, 46], [210, 66],
      ])}
      fill={color}
      opacity={0.9}
    />
    {/* Snow line — the Atlas keeps its caps into spring. */}
    <path d="M42,40 L48,34 L54,41 L50,42 L46,39 Z" fill={line} opacity={0.5} />
    <path d="M106,36 L112,30 L119,38 L112,37 Z" fill={line} opacity={0.5} />
    <path
      d={ridge([[-10, 84], [26, 70], [58, 80], [96, 66], [140, 78], [180, 68], [210, 80]])}
      fill={accent}
      opacity={0.35}
    />
  </g>
);

const AndesRidge: React.FC<MotifProps> = ({color, line, accent}) => (
  <g>
    <path
      d={ridge([
        [-10, 70], [18, 26], [34, 52], [52, 18], [68, 46], [84, 30],
        [104, 58], [124, 22], [142, 50], [162, 34], [184, 56], [210, 44],
      ])}
      fill={color}
      opacity={0.92}
    />
    {[
      [52, 18], [124, 22], [18, 26],
    ].map(([x, y], i) => (
      <path key={i} d={`M${x! - 7},${y! + 9} L${x},${y} L${x! + 8},${y! + 10} L${x! + 1},${y! + 6} Z`} fill={line} opacity={0.55} />
    ))}
    <path
      d={ridge([[-10, 86], [40, 74], [90, 84], [140, 72], [210, 86]])}
      fill={accent}
      opacity={0.3}
    />
  </g>
);

const RamblaCoast: React.FC<MotifProps> = ({color, line, accent}) => (
  <g>
    {/* Río de la Plata horizon, and the Rambla curving away. */}
    <rect x="-10" y="62" width={MOTIF_W + 20} height={MOTIF_H} fill={accent} opacity={0.22} />
    <path d="M-10,62 L210,62" stroke={line} strokeWidth="0.5" opacity={0.4} />
    <path
      d="M-10,96 C30,84 62,80 100,80 C142,80 174,86 210,78 L210,110 L-10,110 Z"
      fill={color}
      opacity={0.9}
    />
    <path
      d="M-10,92 C30,80 62,76 100,76 C142,76 174,82 210,74"
      fill="none"
      stroke={line}
      strokeWidth="0.7"
      opacity={0.55}
    />
    {/* Rambla lamp posts, receding. */}
    {[16, 52, 92, 136, 178].map((x, i) => (
      <g key={x} opacity={0.7 - i * 0.06}>
        <rect x={x} y={72 - i} width="0.7" height={14} fill={line} opacity={0.6} />
        <circle cx={x + 0.35} cy={71 - i} r="1.4" fill={line} opacity={0.5} />
      </g>
    ))}
  </g>
);

const LisbonHills: React.FC<MotifProps> = ({color, line, accent}) => (
  <g>
    {/* Rooftops stepping up a hill, Belém Tower right, a caravel sail beyond. */}
    <path
      d={ridge([[-10, 88], [30, 78], [70, 66], [110, 56], [150, 62], [210, 58]])}
      fill={accent}
      opacity={0.28}
    />
    <g fill={color} opacity={0.92}>
      {[
        [4, 84], [22, 79], [40, 74], [58, 70], [76, 65], [94, 61], [112, 63], [130, 67],
      ].map(([x, y], i) => (
        <g key={i}>
          <rect x={x} y={y} width="15" height={MOTIF_H - y!} />
          <path d={`M${x! - 1.5},${y} L${x! + 7.5},${y! - 5} L${x! + 16.5},${y} Z`} />
        </g>
      ))}
    </g>
    {/* Belém Tower. */}
    <g fill={color} opacity={0.95}>
      <rect x="164" y="52" width="14" height="48" />
      <rect x="161" y="66" width="20" height="34" />
      <rect x="166" y="46" width="10" height="7" />
      {[164, 170, 176].map((x) => (
        <rect key={x} x={x} y="42" width="3" height="5" />
      ))}
    </g>
    {/* Caravel sail on the estuary. */}
    <path d="M140,74 L140,52 C150,58 150,68 148,74 Z" fill={line} opacity={0.45} />
  </g>
);

const PlazaArcade: React.FC<MotifProps> = ({color, line, accent}) => (
  <g>
    {/* Golden-hour sun behind a plaza arcade. */}
    <circle cx="100" cy="58" r="26" fill={accent} opacity={0.3} />
    <rect x="-10" y="34" width={MOTIF_W + 20} height="8" fill={color} opacity={0.9} />
    {Array.from({length: 11}, (_, i) => {
      const x = -6 + i * 19;
      return (
        <g key={i} fill={color} opacity={0.9}>
          <path d={`M${x},${MOTIF_H} L${x},60 A7.5,7.5 0 0 1 ${x + 15},60 L${x + 15},${MOTIF_H} Z`} fillRule="evenodd" />
        </g>
      );
    })}
    {/* Cut the arch openings back out. */}
    {Array.from({length: 11}, (_, i) => {
      const x = -6 + i * 19 + 3.5;
      return (
        <path
          key={i}
          d={`M${x},${MOTIF_H} L${x},62 A4,4 0 0 1 ${x + 8},62 L${x + 8},${MOTIF_H} Z`}
          fill={accent}
          opacity={0.32}
        />
      );
    })}
    <rect x="-10" y="42" width={MOTIF_W + 20} height="1" fill={line} opacity={0.4} />
  </g>
);

const JesuitRuins: React.FC<MotifProps> = ({color, line, accent}) => (
  <g>
    <path d={ridge([[-10, 90], [60, 84], [140, 88], [210, 82]])} fill={accent} opacity={0.24} />
    {/* Broken arcade of the reductions — deliberately incomplete. */}
    {[
      {x: 8, h: 46, broken: false},
      {x: 40, h: 44, broken: true},
      {x: 72, h: 48, broken: false},
      {x: 104, h: 30, broken: true},
      {x: 136, h: 46, broken: false},
      {x: 168, h: 38, broken: true},
    ].map(({x, h, broken}) => (
      <g key={x} fill={color} opacity={0.92}>
        <rect x={x} y={MOTIF_H - h} width="7" height={h} />
        <rect x={x + 19} y={MOTIF_H - h} width="7" height={h} />
        {!broken ? (
          <path
            d={`M${x},${MOTIF_H - h} L${x},${MOTIF_H - h - 3} A13,13 0 0 1 ${x + 26},${
              MOTIF_H - h - 3
            } L${x + 26},${MOTIF_H - h} L${x + 19},${MOTIF_H - h} A6.5,6.5 0 0 0 ${x + 7},${
              MOTIF_H - h
            } Z`}
          />
        ) : (
          <path d={`M${x},${MOTIF_H - h} L${x},${MOTIF_H - h - 4} L${x + 8},${MOTIF_H - h - 1} Z`} />
        )}
      </g>
    ))}
    <rect x="-10" y="99" width={MOTIF_W + 20} height="1" fill={line} opacity={0.35} />
  </g>
);

// ─── MID: architecture and human figures ────────────────────────────────────

const MedinaArches: React.FC<MotifProps> = ({color, line, accent, progress}) => (
  <g>
    {/* Three horseshoe arches of a riad courtyard, with the fountain beneath. */}
    {[36, 100, 164].map((cx, i) => {
      const r = i === 1 ? 17 : 13;
      const springLine = (i === 1 ? 16 : 26) + r;
      // A horseshoe arch is more than a semicircle: the curve carries past its
      // widest point and the jambs tuck back in beneath it. Drawing it as an
      // arc between the pier tops only ever yields a plain round-headed arch,
      // which is a European form, not a Moroccan one.
      const tuck = r * 0.84;
      const foot = springLine + r * 0.62;
      const opening = `
        M${cx - tuck},${MOTIF_H}
        L${cx - tuck},${foot}
        A${r},${r} 0 1 1 ${cx + tuck},${foot}
        L${cx + tuck},${MOTIF_H} Z`;
      return (
        <g key={cx}>
          <path d={opening} fill={color} opacity={0.45} />
          <path d={opening} fill="none" stroke={line} strokeWidth="1.8" opacity={0.9} />
          {/* Zellige-tiled spandrel band above the arch. */}
          <rect
            x={cx - r - 5}
            y={springLine - r - 5}
            width={(r + 5) * 2}
            height="2.2"
            fill={accent}
            opacity={0.5}
          />
        </g>
      );
    })}
    {/* Fountain: concentric rings, rippling. */}
    <g opacity={0.8}>
      {[0, 1, 2].map((r) => {
        const phase = (progress * 2 + r * 0.33) % 1;
        return (
          <ellipse
            key={r}
            cx="100"
            cy="86"
            rx={6 + phase * 20}
            ry={(6 + phase * 20) * 0.3}
            fill="none"
            stroke={accent}
            strokeWidth="0.8"
            opacity={(1 - phase) * 0.7}
          />
        );
      })}
    </g>
    {/* Mint tea pour — a thin arc of liquid, the Moroccan welcome. */}
    <path
      d="M78,58 C82,66 84,74 82,84"
      fill="none"
      stroke={accent}
      strokeWidth="1"
      opacity={0.7}
      strokeDasharray="2 2"
    />
  </g>
);

const FlamencoSpiral: React.FC<MotifProps> = ({color, line, accent, progress}) => (
  <g>
    {/* A skirt as a spiral: nested arcs rotating at different rates. */}
    <g transform="translate(100 62)">
      {Array.from({length: 9}, (_, i) => {
        const r = 8 + i * 5.2;
        const rot = progress * (60 + i * 22);
        return (
          <path
            key={i}
            d={`M${-r},0 A${r},${r * 0.52} 0 0 1 ${r},0`}
            fill="none"
            stroke={i % 2 ? accent : line}
            strokeWidth={1.4 - i * 0.09}
            opacity={0.85 - i * 0.06}
            transform={`rotate(${rot})`}
          />
        );
      })}
    </g>
    {/* The dancer: torso, raised arms, the shape of a rasgueado held. */}
    <path
      d="M100,60 L100,34 M100,38 C94,30 88,26 82,24 M100,38 C106,30 112,26 118,24"
      stroke={color}
      strokeWidth="3"
      strokeLinecap="round"
      fill="none"
      opacity={0.95}
    />
    <circle cx="100" cy="28" r="4.4" fill={color} opacity={0.95} />
  </g>
);

const Tram28: React.FC<MotifProps> = ({color, line, accent, progress}) => {
  // The tram climbs; the hill runs beneath it.
  const climb = -6 + progress * 12;
  return (
    <g>
      <path d={`M-10,${MOTIF_H} L210,${MOTIF_H - 34} L210,${MOTIF_H} Z`} fill={accent} opacity={0.2} />
      <path d={`M-10,${MOTIF_H - 4} L210,${MOTIF_H - 38}`} stroke={line} strokeWidth="0.8" opacity={0.5} />
      <g transform={`translate(${58 + climb} ${-climb * 0.16})`}>
        <g transform="rotate(-9.6)">
          <rect x="0" y="44" width="62" height="30" rx="3" fill={color} opacity={0.95} />
          <rect x="0" y="38" width="62" height="7" rx="2" fill={color} opacity={0.95} />
          {[6, 20, 34, 48].map((x) => (
            <rect key={x} x={x} y="49" width="10" height="11" fill={line} opacity={0.55} />
          ))}
          <circle cx="14" cy="76" r="3.4" fill={color} />
          <circle cx="48" cy="76" r="3.4" fill={color} />
          {/* Pantograph to the overhead line. */}
          <path d="M31,38 L31,28 M22,26 L40,26" stroke={line} strokeWidth="1" opacity={0.7} />
        </g>
      </g>
      <path d="M-10,20 L210,4" stroke={line} strokeWidth="0.6" opacity={0.45} />
    </g>
  );
};

/**
 * The Estadio Centenario, reduced to the one thing that makes it unmistakable:
 * the Torre de los Homenajes standing over the bowl. Shot 02 builds this ground
 * in 3D; this is the flat echo of it, and Shot 11 echoes it again.
 */
const CentenarioArch: React.FC<MotifProps> = ({color, line, accent}) => (
  <g>
    {/* Bowl. */}
    <path
      d="M14,100 C14,74 46,58 100,58 C154,58 186,74 186,100 Z"
      fill={color}
      opacity={0.9}
    />
    <path
      d="M28,100 C28,80 56,68 100,68 C144,68 172,80 172,100"
      fill="none"
      stroke={line}
      strokeWidth="0.9"
      opacity={0.55}
    />
    {/* Floodlight pylons. */}
    {[26, 174].map((x) => (
      <g key={x}>
        <rect x={x} y="52" width="1.6" height="30" fill={line} opacity={0.6} />
        <rect x={x - 4} y="48" width="9.6" height="4" fill={line} opacity={0.6} />
      </g>
    ))}
    {/* Torre de los Homenajes. */}
    <g fill={line} opacity={0.92}>
      <path d="M92,60 L92,14 L96,6 L104,6 L108,14 L108,60 Z" />
      <rect x="88" y="26" width="24" height="2.4" opacity={0.8} />
      <rect x="90" y="38" width="20" height="2.4" opacity={0.8} />
    </g>
    <path d="M96,6 L100,0 L104,6 Z" fill={accent} opacity={0.9} />
  </g>
);

const TangoCouple: React.FC<MotifProps> = ({color, line, accent, progress}) => {
  const lean = Math.sin(progress * Math.PI * 2) * 4;
  return (
    <g>
      {/* Corrugated La Boca facades behind. */}
      <g opacity={0.35}>
        {[10, 34, 58, 142, 166, 190].map((x, i) => (
          <rect
            key={x}
            x={x}
            y={44 + (i % 3) * 6}
            width="20"
            height={MOTIF_H}
            fill={i % 2 ? accent : color}
          />
        ))}
      </g>
      <g transform={`translate(100 0) rotate(${lean} 0 90)`}>
        {/* Two figures, joined at the hands — the tango's whole grammar. */}
        <path
          d="M-14,96 L-10,58 L-14,36 M-10,58 L4,50 M-10,58 L-22,52 M-14,96 L-26,92"
          stroke={color}
          strokeWidth="3.2"
          strokeLinecap="round"
          fill="none"
        />
        <circle cx="-14" cy="31" r="4.6" fill={color} />
        <path
          d="M16,96 L12,58 L16,34 M12,58 L4,50 M12,58 L26,54 M16,96 L30,88"
          stroke={line}
          strokeWidth="3.2"
          strokeLinecap="round"
          fill="none"
        />
        <circle cx="16" cy="29" r="4.6" fill={line} />
        {/* Her leg extended — the gancho. */}
        <path d="M16,96 L38,100" stroke={line} strokeWidth="3" strokeLinecap="round" />
      </g>
    </g>
  );
};

const Harp: React.FC<MotifProps> = ({color, line, accent, progress}) => (
  <g>
    {/* Paraguayan harp — 36 strings, played standing. */}
    <g transform="translate(100 0)">
      <path d="M-18,96 L-18,30 C0,26 22,44 28,94 Z" fill={color} opacity={0.95} />
      <path d="M-18,96 L-18,30 C0,26 22,44 28,94 Z" fill={accent} opacity={0.18} />
      <path d="M-18,30 C0,26 22,44 28,94" fill="none" stroke={line} strokeWidth="2.2" />
      <path d="M-18,96 L-18,30" stroke={line} strokeWidth="2.2" />
      {Array.from({length: 18}, (_, i) => {
        const t = i / 17;
        const x1 = -18;
        const y1 = 30 + t * 64;
        const x2 = -18 + (1 - t) * 6 + t * 46;
        const y2 = 30 + t * 64 * 0.2 + t * t * 34;
        // Strings ring in sequence as the arpeggio climbs.
        const lit = Math.abs(((progress * 1.6) % 1) - t) < 0.09;
        return (
          <line
            key={i}
            x1={x1}
            y1={y1}
            x2={x2}
            y2={y2 + 30}
            stroke={lit ? accent : line}
            strokeWidth={lit ? 1.1 : 0.5}
            opacity={lit ? 0.95 : 0.5}
          />
        );
      })}
      <rect x="-22" y="94" width="54" height="4" rx="1.5" fill={color} opacity={0.9} />
    </g>
  </g>
);

// ─── NEAR: ornament, tessellating ───────────────────────────────────────────

const Zellige: React.FC<MotifProps> = ({line, accent, uid, density = 1}) => {
  const cell = 26 / density;
  const star = (cx: number, cy: number, r: number, points = 8) =>
    Array.from({length: points * 2}, (_, i) => {
      const rad = i % 2 === 0 ? r : r * 0.44;
      const a = (i * Math.PI) / points - Math.PI / 2;
      return `${(cx + Math.cos(a) * rad).toFixed(2)},${(cy + Math.sin(a) * rad).toFixed(2)}`;
    }).join(' ');

  return (
    <>
      <defs>
        <pattern id={`zellige-${uid}`} width={cell} height={cell} patternUnits="userSpaceOnUse">
          <polygon points={star(cell / 2, cell / 2, cell * 0.42)} fill="none" stroke={line} strokeWidth={0.8 / density} />
          {[[0, 0], [cell, 0], [0, cell], [cell, cell]].map(([cx, cy], i) => (
            <polygon key={i} points={star(cx!, cy!, cell * 0.42)} fill="none" stroke={accent} strokeWidth={0.8 / density} />
          ))}
          <rect
            x={cell * 0.42}
            y={cell * 0.42}
            width={cell * 0.16}
            height={cell * 0.16}
            fill={line}
            opacity={0.5}
            transform={`rotate(45 ${cell / 2} ${cell / 2})`}
          />
        </pattern>
      </defs>
      <rect x="-20" y="-20" width={MOTIF_W + 40} height={MOTIF_H + 40} fill={`url(#zellige-${uid})`} />
    </>
  );
};

const Trencadis: React.FC<MotifProps> = ({line, accent, color, progress, uid}) => {
  // Gaudí's broken-tile mosaic: shards that shatter apart and reassemble.
  const shards = useMemo(
    () =>
      Array.from({length: 84}, (_, i) => {
        const cx = random(`tx-${uid}-${i}`) * MOTIF_W;
        const cy = random(`ty-${uid}-${i}`) * MOTIF_H;
        const s = 3 + random(`ts-${uid}-${i}`) * 6;
        const rot = random(`tr-${uid}-${i}`) * 90;
        const skew = 0.5 + random(`tk-${uid}-${i}`);
        return {cx, cy, s, rot, skew, i};
      }),
    [uid],
  );

  // Shatter out, then come back together — peaks at the halfway point.
  const burst = Math.sin(Math.min(1, progress) * Math.PI) ** 1.4;

  return (
    <g>
      {shards.map(({cx, cy, s, rot, skew, i}) => {
        const dir = random(`td-${uid}-${i}`) * Math.PI * 2;
        const dist = burst * (6 + random(`tm-${uid}-${i}`) * 26);
        const fill = i % 5 === 0 ? accent : i % 3 === 0 ? line : color;
        return (
          <rect
            key={i}
            x={cx + Math.cos(dir) * dist}
            y={cy + Math.sin(dir) * dist}
            width={s}
            height={s * skew}
            fill={fill}
            opacity={0.28 + (i % 4) * 0.12}
            transform={`rotate(${rot + burst * 90} ${cx} ${cy})`}
          />
        );
      })}
    </g>
  );
};

const Azulejo: React.FC<MotifProps> = ({line, accent, uid, density = 1}) => (
  <>
    <defs>
      <pattern
        id={`azulejo-${uid}`}
        width="22"
        height="22"
        patternUnits="userSpaceOnUse"
        patternTransform={`scale(${1 / density})`}
      >
        <rect width="22" height="22" fill="none" stroke={line} strokeWidth="0.5" opacity={0.5} />
        {/* Quatrefoil. */}
        <path
          d="M11,4 C15,4 18,7 18,11 C18,15 15,18 11,18 C7,18 4,15 4,11 C4,7 7,4 11,4 Z"
          fill="none"
          stroke={accent}
          strokeWidth="0.8"
        />
        <path d="M11,2 L13,6 L11,11 L9,6 Z M20,11 L16,13 L11,11 L16,9 Z M11,20 L9,16 L11,11 L13,16 Z M2,11 L6,9 L11,11 L6,13 Z" fill={accent} opacity={0.6} />
        <circle cx="11" cy="11" r="1.4" fill={line} opacity={0.7} />
      </pattern>
      {/* Calçada portuguesa — the wave paving of the Lisbon pavements. */}
      <pattern
        id={`calcada-${uid}`}
        width="40"
        height="14"
        patternUnits="userSpaceOnUse"
        patternTransform={`scale(${1 / density})`}
      >
        <path d="M0,7 C10,0 30,14 40,7" fill="none" stroke={line} strokeWidth="1.1" opacity={0.55} />
      </pattern>
    </defs>
    <rect x="-20" y="-20" width={MOTIF_W + 40} height={MOTIF_H + 40} fill={`url(#azulejo-${uid})`} />
    <rect x="-20" y={MOTIF_H - 22} width={MOTIF_W + 40} height="42" fill={`url(#calcada-${uid})`} />
  </>
);

const SunOfMay: React.FC<MotifProps> = ({line, accent, progress}) => (
  <g transform={`translate(100 50) rotate(${progress * 26})`}>
    {Array.from({length: 32}, (_, i) => {
      const a = (i / 32) * Math.PI * 2;
      const straight = i % 2 === 0;
      const inner = 20;
      const outer = straight ? 62 : 50;
      const x1 = Math.cos(a) * inner;
      const y1 = Math.sin(a) * inner;
      const x2 = Math.cos(a) * outer;
      const y2 = Math.sin(a) * outer;
      const perp = a + Math.PI / 2;
      return straight ? (
        <path
          key={i}
          d={`M${x1},${y1} L${x2},${y2}`}
          stroke={accent}
          strokeWidth="1.6"
          opacity={0.6}
        />
      ) : (
        // Flame ray, curved — the Sol de Mayo alternates the two.
        <path
          key={i}
          d={`M${x1},${y1} Q${(x1 + x2) / 2 + Math.cos(perp) * 7},${
            (y1 + y2) / 2 + Math.sin(perp) * 7
          } ${x2},${y2}`}
          fill="none"
          stroke={accent}
          strokeWidth="1.4"
          opacity={0.5}
        />
      );
    })}
    <circle cx="0" cy="0" r="18" fill="none" stroke={line} strokeWidth="1.5" opacity={0.7} />
    <circle cx="0" cy="0" r="13" fill="none" stroke={line} strokeWidth="0.7" opacity={0.45} />
  </g>
);

const Fileteado: React.FC<MotifProps> = ({line, accent}) => {
  // Fileteado porteño: symmetrical scrollwork, always mirrored about a spine.
  const scroll = (x: number, flip: number) =>
    `M${x},58 C${x + 16 * flip},44 ${x + 30 * flip},50 ${x + 26 * flip},62
     C${x + 23 * flip},72 ${x + 10 * flip},70 ${x + 12 * flip},60
     C${x + 13 * flip},54 ${x + 21 * flip},55 ${x + 20 * flip},61`;
  return (
    <g>
      {[36, 100, 164].map((x, i) => (
        <g key={x} opacity={0.75 - i * 0.06}>
          <path d={scroll(x, 1)} fill="none" stroke={accent} strokeWidth="1.5" strokeLinecap="round" />
          <path d={scroll(x, -1)} fill="none" stroke={accent} strokeWidth="1.5" strokeLinecap="round" />
          <path d={scroll(x, 1)} fill="none" stroke={line} strokeWidth="0.5" strokeLinecap="round" transform="translate(0 3)" />
          <path d={scroll(x, -1)} fill="none" stroke={line} strokeWidth="0.5" strokeLinecap="round" transform="translate(0 3)" />
        </g>
      ))}
      {/* Twin rules top and bottom — fileteado always frames itself. */}
      {[16, 88].map((y) => (
        <g key={y}>
          <rect x="-20" y={y} width={MOTIF_W + 40} height="0.9" fill={line} opacity={0.5} />
          <rect x="-20" y={y + 3} width={MOTIF_W + 40} height="0.4" fill={accent} opacity={0.6} />
        </g>
      ))}
    </g>
  );
};

const Nanduti: React.FC<MotifProps> = ({line, accent, progress}) => (
  <g>
    {/* Ñandutí — "spiderweb" in Guaraní. Radial lace, drawn from the centre out. */}
    {[
      {cx: 46, cy: 46, r: 34, spokes: 16},
      {cx: 148, cy: 58, r: 28, spokes: 12},
      {cx: 100, cy: 22, r: 18, spokes: 10},
    ].map((web, wi) => {
      const grow = Math.max(0, Math.min(1, progress * 1.6 - wi * 0.18));
      return (
        <g key={wi} opacity={0.8}>
          {Array.from({length: web.spokes}, (_, i) => {
            const a = (i / web.spokes) * Math.PI * 2;
            return (
              <line
                key={i}
                x1={web.cx}
                y1={web.cy}
                x2={web.cx + Math.cos(a) * web.r * grow}
                y2={web.cy + Math.sin(a) * web.r * grow}
                stroke={line}
                strokeWidth="0.6"
                opacity={0.65}
              />
            );
          })}
          {[0.3, 0.55, 0.78, 1].map((ring, ri) => (
            <circle
              key={ri}
              cx={web.cx}
              cy={web.cy}
              r={web.r * ring * grow}
              fill="none"
              stroke={ri % 2 ? accent : line}
              strokeWidth="0.7"
              opacity={0.6}
            />
          ))}
          {/* Guaraní geometric infill between the rings. */}
          {Array.from({length: web.spokes}, (_, i) => {
            const a = ((i + 0.5) / web.spokes) * Math.PI * 2;
            const r1 = web.r * 0.55 * grow;
            const r2 = web.r * 0.78 * grow;
            return (
              <path
                key={i}
                d={`M${web.cx + Math.cos(a) * r1},${web.cy + Math.sin(a) * r1}
                    L${web.cx + Math.cos(a - 0.12) * r2},${web.cy + Math.sin(a - 0.12) * r2}
                    L${web.cx + Math.cos(a + 0.12) * r2},${web.cy + Math.sin(a + 0.12) * r2} Z`}
                fill={accent}
                opacity={0.35}
              />
            );
          })}
        </g>
      );
    })}
  </g>
);

const RENDERERS: Record<MotifKind, React.FC<MotifProps>> = {
  'atlas-ridge': AtlasRidge,
  'andes-ridge': AndesRidge,
  'rambla-coast': RamblaCoast,
  'lisbon-hills': LisbonHills,
  'plaza-arcade': PlazaArcade,
  'jesuit-ruins': JesuitRuins,
  'medina-arches': MedinaArches,
  'flamenco-spiral': FlamencoSpiral,
  'tram-28': Tram28,
  'centenario-arch': CentenarioArch,
  'tango-couple': TangoCouple,
  harp: Harp,
  zellige: Zellige,
  trencadis: Trencadis,
  azulejo: Azulejo,
  'sun-of-may': SunOfMay,
  fileteado: Fileteado,
  nanduti: Nanduti,
};

export const Motif: React.FC<MotifProps> = (props) => {
  const Renderer = RENDERERS[props.kind];
  return <Renderer {...props} />;
};
