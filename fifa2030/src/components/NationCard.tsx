import {evolvePath, getBoundingBox} from '@remotion/paths';
import {interpolate, spring, useCurrentFrame, useVideoConfig} from 'remotion';
import {useLayout} from '../config/layout';
import type {Nation} from '../config/nations';
import {fontStacks, letterspacing, palette, springs, typeScale} from '../config/theme';
import {Motif, MOTIF_H, MOTIF_W} from './Motifs';

/**
 * The two typographic fixtures of a nation module: the country outline that
 * draws itself in gold and then fills with its own ornament, and the name
 * lockup that carries the nation in English and in its own language.
 */

export const CountryOutline: React.FC<{
  nation: Nation;
  /** 0 → 1 stroke draw. */
  draw: number;
  /** 0 → 1 texture fill, after the draw completes. */
  fill: number;
  strokeColor?: string;
}> = ({nation, draw, fill, strokeColor = palette.goldTrophy}) => {
  const evolved = evolvePath(draw, nation.outline);
  const box = getBoundingBox(nation.outline);
  const uid = `outline-${nation.id}`;

  return (
    <svg viewBox="0 0 100 100" width="100%" height="100%" preserveAspectRatio="xMidYMid meet">
      <defs>
        <clipPath id={uid}>
          <path d={nation.outline} />
        </clipPath>
      </defs>

      {/* The ornament fills the country from inside its own borders. */}
      <g clipPath={`url(#${uid})`} opacity={fill}>
        <rect
          x={box.x1}
          y={box.y1}
          width={box.x2 - box.x1}
          height={box.y2 - box.y1}
          fill={nation.colors.field}
          opacity={0.55}
        />
        <g
          transform={`translate(${box.x1} ${box.y1}) scale(${(box.x2 - box.x1) / MOTIF_W} ${
            (box.y2 - box.y1) / MOTIF_H
          })`}
        >
          <Motif
            kind={nation.motifs[2]}
            color={nation.colors.field}
            accent={palette.goldTrophy}
            line={nation.colors.line}
            progress={fill}
            uid={`fill-${nation.id}`}
            density={2.6}
          />
        </g>
      </g>

      {/* Stroke width and dash lengths must both stay in path units. With
          vectorEffect="non-scaling-stroke" Chrome measures the dashes in screen
          pixels while the path itself is scaled, and the draw-on shatters into
          repeating fragments. */}
      <path
        d={nation.outline}
        fill="none"
        stroke={strokeColor}
        strokeWidth={0.85}
        strokeLinejoin="round"
        strokeLinecap="round"
        strokeDasharray={evolved.strokeDasharray}
        strokeDashoffset={evolved.strokeDashoffset}
      />
    </svg>
  );
};

/**
 * Nation name in English and in the local language/script, with the host role
 * beneath. Arabic is set right-to-left in Noto Sans Arabic; every other name
 * uses the display face.
 */
export const NationNameLock: React.FC<{
  nation: Nation;
  /** Frame the lockup starts on, relative to the enclosing Sequence. */
  delay: number;
  align?: 'center' | 'left';
}> = ({nation, delay, align = 'center'}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const {t, u} = useLayout();

  const enter = spring({
    frame: frame - delay,
    fps,
    config: springs.slam,
    durationInFrames: 26,
  });
  const localEnter = spring({
    frame: frame - delay - 7,
    fps,
    config: springs.type,
    durationInFrames: 30,
  });
  const roleEnter = spring({
    frame: frame - delay - 13,
    fps,
    config: springs.type,
    durationInFrames: 26,
  });

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: align === 'center' ? 'center' : 'flex-start',
        gap: u(0.8),
        width: '100%',
      }}
    >
      <div style={{overflow: 'hidden', paddingBottom: '0.06em'}}>
        <div
          style={{
            fontFamily: fontStacks.display,
            fontSize: t(typeScale.display),
            lineHeight: 1,
            color: palette.bone,
            textTransform: 'uppercase',
            letterSpacing: letterspacing.tight,
            transform: `translateY(${interpolate(enter, [0, 1], [110, 0])}%)`,
          }}
        >
          {nation.nameEn}
        </div>
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: u(1.6),
          opacity: localEnter,
          transform: `translateY(${interpolate(localEnter, [0, 1], [u(1.4), 0])}px)`,
          flexWrap: 'wrap',
          justifyContent: align === 'center' ? 'center' : 'flex-start',
        }}
      >
        <span
          style={{
            fontFamily: nation.rtl ? fontStacks.arabic : fontStacks.body,
            fontSize: t(typeScale.subtitle),
            fontWeight: 600,
            color: palette.goldLight,
            direction: nation.rtl ? 'rtl' : 'ltr',
            letterSpacing: nation.rtl ? 0 : letterspacing.wide,
          }}
        >
          {nation.nameLocal}
        </span>
        <span
          style={{
            fontFamily: fontStacks.body,
            fontSize: t(typeScale.caption),
            fontWeight: 500,
            color: palette.bone,
            opacity: 0.6,
            letterSpacing: letterspacing.wide,
          }}
        >
          {nation.localLanguage}
        </span>
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: u(1.2),
          opacity: roleEnter * 0.92,
        }}
      >
        <div
          style={{
            width: u(3.2) * roleEnter,
            height: u(0.22),
            backgroundColor:
              nation.role === 'centenary' ? palette.goldTrophy : palette.bone,
          }}
        />
        <span
          style={{
            fontFamily: fontStacks.body,
            fontSize: t(typeScale.caption),
            fontWeight: 500,
            textTransform: 'uppercase',
            letterSpacing: letterspacing.ultra,
            // Gold is earned: only the three centenary hosts get it here.
            color: nation.role === 'centenary' ? palette.goldTrophy : palette.bone,
            whiteSpace: 'nowrap',
          }}
        >
          {nation.hostLine}
        </span>
      </div>
    </div>
  );
};
