import {useMemo} from 'react';
import {Img, random} from 'remotion';
import {FLAG_H, FLAG_W, type FlagLayer, type FlagSpec} from '../config/flags';

/**
 * Renders a flag from its primitive layers, optionally rippling.
 *
 * The ripple is a real vertical displacement applied per column, not a CSS
 * skew: a flag in a crowd has to bend along its own length, and a skewed
 * rectangle reads as a parallelogram rather than as cloth.
 */

const starPoints = (cx: number, cy: number, r: number, points = 5, rot = -90): string =>
  Array.from({length: points * 2}, (_, i) => {
    const rad = i % 2 === 0 ? r : r * (points === 4 ? 0.3 : points >= 8 ? 0.5 : 0.382);
    const a = ((i * 180) / points + rot) * (Math.PI / 180);
    return `${(cx + Math.cos(a) * rad).toFixed(2)},${(cy + Math.sin(a) * rad).toFixed(2)}`;
  }).join(' ');

const Layer: React.FC<{layer: FlagLayer; uid: string; i: number}> = ({layer, uid, i}) => {
  switch (layer.t) {
    case 'bands': {
      const weights = layer.weights ?? layer.colors.map(() => 1);
      const total = weights.reduce((a, b) => a + b, 0);
      let cursor = 0;
      return (
        <>
          {layer.colors.map((color, bi) => {
            const span = ((weights[bi] ?? 1) / total) * (layer.dir === 'h' ? FLAG_H : FLAG_W);
            const at = cursor;
            cursor += span;
            return layer.dir === 'h' ? (
              <rect key={bi} x={0} y={at} width={FLAG_W} height={span + 0.4} fill={color} />
            ) : (
              <rect key={bi} x={at} y={0} width={span + 0.4} height={FLAG_H} fill={color} />
            );
          })}
        </>
      );
    }
    case 'rect':
      return <rect x={layer.x} y={layer.y} width={layer.w} height={layer.h} fill={layer.color} />;
    case 'disc':
      return <circle cx={layer.cx} cy={layer.cy} r={layer.r} fill={layer.color} />;
    case 'ring':
      return (
        <circle
          cx={layer.cx}
          cy={layer.cy}
          r={layer.r}
          fill="none"
          stroke={layer.color}
          strokeWidth={layer.width}
        />
      );
    case 'star':
      return (
        <polygon
          points={starPoints(layer.cx, layer.cy, layer.r, layer.points, layer.rot)}
          fill={layer.color}
        />
      );
    case 'crescent':
      // Disc minus an offset disc, via a mask — a crescent drawn as an arc
      // path never closes cleanly at these sizes.
      return (
        <>
          <mask id={`cres-${uid}-${i}`}>
            <rect x="0" y="0" width={FLAG_W} height={FLAG_H} fill="black" />
            <circle cx={layer.cx} cy={layer.cy} r={layer.r} fill="white" />
            <circle cx={layer.cx + layer.r * 0.42} cy={layer.cy} r={layer.r * 0.82} fill="black" />
          </mask>
          <rect
            x="0"
            y="0"
            width={FLAG_W}
            height={FLAG_H}
            fill={layer.color}
            mask={`url(#cres-${uid}-${i})`}
          />
        </>
      );
    case 'cross': {
      const ox = layer.offsetX ?? 0;
      return (
        <>
          <rect x={0} y={FLAG_H / 2 - layer.thickness / 2} width={FLAG_W} height={layer.thickness} fill={layer.color} />
          <rect x={FLAG_W / 2 + ox - layer.thickness / 2} y={0} width={layer.thickness} height={FLAG_H} fill={layer.color} />
        </>
      );
    }
    case 'saltire': {
      const len = Math.hypot(FLAG_W, FLAG_H);
      const angle = (Math.atan2(FLAG_H, FLAG_W) * 180) / Math.PI;
      return (
        <>
          {[angle, -angle].map((a) => (
            <rect
              key={a}
              x={FLAG_W / 2 - len / 2}
              y={FLAG_H / 2 - layer.thickness / 2}
              width={len}
              height={layer.thickness}
              fill={layer.color}
              transform={`rotate(${a} ${FLAG_W / 2} ${FLAG_H / 2})`}
            />
          ))}
        </>
      );
    }
    case 'triangle':
      return (
        <polygon
          points={`0,0 ${layer.width},${FLAG_H / 2} 0,${FLAG_H}`}
          fill={layer.color}
        />
      );
    case 'diamond':
      return (
        <polygon
          points={`${layer.cx},${layer.cy - layer.ry} ${layer.cx + layer.rx},${layer.cy} ${layer.cx},${
            layer.cy + layer.ry
          } ${layer.cx - layer.rx},${layer.cy}`}
          fill={layer.color}
        />
      );
    case 'starfield': {
      const out: React.ReactNode[] = [];
      for (let r = 0; r < layer.rows; r++) {
        for (let c = 0; c < layer.cols; c++) {
          const cx = layer.x + ((c + 0.5) / layer.cols) * layer.w;
          const cy = layer.y + ((r + 0.5) / layer.rows) * layer.h;
          out.push(
            <polygon key={`${r}-${c}`} points={starPoints(cx, cy, layer.r)} fill={layer.color} />,
          );
        }
      }
      return <>{out}</>;
    }
    default:
      return null;
  }
};

export const Flag: React.FC<{
  spec: FlagSpec;
  /** Phase of the ripple, in radians. 0 disables it. */
  wave?: number;
  /** Ripple depth as a fraction of flag height. */
  waveAmount?: number;
  /** Hairline border so pale flags read against pale backgrounds. */
  bordered?: boolean;
  className?: string;
  style?: React.CSSProperties;
}> = ({spec, wave = 0, waveAmount = 0.1, bordered = true, style}) => {
  const uid = spec.code;

  // Cloth ripple: sample the flag into vertical slices and displace each by a
  // travelling sine. Cheap, and it bends rather than shears.
  const slices = useMemo(() => (wave ? 16 : 0), [wave]);

  if (spec.assetSrc) {
    // SWAP POINT: an official vector flag replaces the constructed one.
    return <Img src={spec.assetSrc} style={{width: '100%', height: '100%', ...style}} />;
  }

  const body = (
    <>
      {spec.layers.map((layer, i) => (
        <Layer key={i} layer={layer} uid={uid} i={i} />
      ))}
    </>
  );

  return (
    <svg
      viewBox={`0 0 ${FLAG_W} ${FLAG_H}`}
      width="100%"
      height="100%"
      preserveAspectRatio="xMidYMid meet"
      style={style}
    >
      <defs>
        <clipPath id={`fc-${uid}`}>
          <rect x="0" y="0" width={FLAG_W} height={FLAG_H} rx="0.6" />
        </clipPath>
      </defs>

      {/* Cloth shading is a single smooth gradient across the whole flag, not
          a tint per slice: a per-slice tint quantises into visible vertical
          bands at any slice count low enough to render cheaply. */}
      {slices ? (
        <g clipPath={`url(#fc-${uid})`}>
          {Array.from({length: slices}, (_, s) => {
            const x = (s / slices) * FLAG_W;
            const w = FLAG_W / slices + 0.3;
            const dy = Math.sin(wave + (s / slices) * Math.PI * 2.2) * FLAG_H * waveAmount;
            // Slices further from the hoist swing more, as real cloth does.
            const swing = (s / slices) ** 1.4;
            return (
              <g key={s} transform={`translate(0 ${dy * swing})`}>
                <svg x={x} y={0} width={w} height={FLAG_H} viewBox={`${x} 0 ${w} ${FLAG_H}`}>
                  {body}
                </svg>
              </g>
            );
          })}
        </g>
      ) : (
        <g clipPath={`url(#fc-${uid})`}>{body}</g>
      )}

      {slices ? (
        <>
          <defs>
            <linearGradient id={`sh-${uid}`} x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="#000" stopOpacity="0.22" />
              <stop offset={`${28 + Math.sin(wave) * 18}%`} stopColor="#000" stopOpacity="0" />
              <stop offset={`${66 + Math.sin(wave + 1.6) * 16}%`} stopColor="#000" stopOpacity="0.16" />
              <stop offset="100%" stopColor="#000" stopOpacity="0" />
            </linearGradient>
          </defs>
          <rect
            x="0"
            y="0"
            width={FLAG_W}
            height={FLAG_H}
            fill={`url(#sh-${uid})`}
            clipPath={`url(#fc-${uid})`}
          />
        </>
      ) : null}

      {bordered ? (
        <rect
          x="0.2"
          y="0.2"
          width={FLAG_W - 0.4}
          height={FLAG_H - 0.4}
          rx="0.6"
          fill="none"
          stroke="rgba(244,239,230,0.35)"
          strokeWidth="0.5"
        />
      ) : null}
    </svg>
  );
};

/**
 * A drifting field of flags — the crowd, and the "everyone" the film is about.
 * Used behind the stadium and under the final lockup.
 */
export const FlagField: React.FC<{
  specs: FlagSpec[];
  /** Seconds. */
  t: number;
  /** 0 → 1 reveal, staggered across the field. */
  reveal: number;
  columns?: number;
  size: number;
  gap: number;
}> = ({specs, t, reveal, columns = 8, size, gap}) => (
  <div
    style={{
      display: 'grid',
      gridTemplateColumns: `repeat(${columns}, ${size}px)`,
      gap,
      justifyContent: 'center',
      alignContent: 'center',
      width: '100%',
    }}
  >
    {specs.map((spec, i) => {
      const stagger = Math.max(0, Math.min(1, reveal * specs.length - i * 0.55));
      return (
        <div
          key={spec.code}
          style={{
            width: size,
            height: size * (FLAG_H / FLAG_W),
            opacity: stagger,
            transform: `translateY(${(1 - stagger) * size * 0.4}px) scale(${
              0.82 + stagger * 0.18
            })`,
          }}
        >
          <Flag spec={spec} wave={t * 2.4 + random(spec.code) * 6} waveAmount={0.07} />
        </div>
      );
    })}
  </div>
);
