import {interpolate, spring, useCurrentFrame, useVideoConfig} from 'remotion';
import {useLayout} from '../config/layout';
import {fontStacks, letterspacing, palette, springs, typeScale} from '../config/theme';

/**
 * The film's type system. Everything typographic in the sequence goes through
 * these primitives so tracking, weight and reveal behaviour stay identical
 * across all twelve shots and all three aspect ratios.
 *
 * Sizes are expressed in the layout `t()` unit, never pixels.
 */

export type RevealMode = 'rise' | 'fade' | 'letterpress' | 'track-in';

type LineProps = {
  children: React.ReactNode;
  /** Frame (relative to the enclosing Sequence) at which this line starts. */
  delay?: number;
  size?: keyof typeof typeScale | number;
  color?: string;
  font?: 'display' | 'body' | 'arabic';
  weight?: number;
  tracking?: keyof typeof letterspacing | string;
  mode?: RevealMode;
  uppercase?: boolean;
  align?: 'center' | 'left' | 'right';
  rtl?: boolean;
  style?: React.CSSProperties;
  /** Tabular numerals — required for anything counting. */
  tabular?: boolean;
};

export const TypeLine: React.FC<LineProps> = ({
  children,
  delay = 0,
  size = 'title',
  color = palette.bone,
  font = 'display',
  weight,
  tracking = 'normal',
  mode = 'rise',
  uppercase = true,
  align = 'center',
  rtl = false,
  style,
  tabular = false,
}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const {t} = useLayout();

  const local = frame - delay;
  const s = spring({
    frame: local,
    fps,
    config: mode === 'letterpress' ? springs.slam : springs.type,
    durationInFrames: mode === 'letterpress' ? 26 : 34,
  });

  const fontSize = typeof size === 'number' ? t(size) : t(typeScale[size]);
  const trackValue =
    tracking in letterspacing ? letterspacing[tracking as keyof typeof letterspacing] : tracking;

  const base: React.CSSProperties = {
    fontFamily: fontStacks[font],
    fontSize,
    lineHeight: 1.02,
    color,
    textTransform: uppercase && font !== 'arabic' ? 'uppercase' : 'none',
    letterSpacing: font === 'arabic' ? '0' : trackValue,
    textAlign: align,
    direction: rtl ? 'rtl' : 'ltr',
    fontWeight: weight ?? (font === 'display' ? 400 : 600),
    fontVariantNumeric: tabular ? 'tabular-nums' : 'normal',
    fontFeatureSettings: tabular ? '"tnum" 1' : undefined,
    willChange: 'transform, opacity',
    ...style,
  };

  if (local < 0) return <div style={{...base, opacity: 0}}>{children}</div>;

  if (mode === 'fade') {
    return <div style={{...base, opacity: s}}>{children}</div>;
  }

  if (mode === 'letterpress') {
    // Pressed-in feel: scales down onto the frame with a hard inner shadow,
    // as if stamped rather than animated on.
    const scale = interpolate(s, [0, 1], [1.22, 1]);
    return (
      <div
        style={{
          ...base,
          opacity: interpolate(s, [0, 0.25, 1], [0, 1, 1]),
          transform: `scale(${scale})`,
          textShadow: `0 ${t(0.12)}px 0 rgba(0,0,0,0.55), 0 ${t(-0.06)}px 0 rgba(255,255,255,${
            0.14 * s
          })`,
        }}
      >
        {children}
      </div>
    );
  }

  if (mode === 'track-in') {
    const extra = interpolate(s, [0, 1], [0.9, 0]);
    return (
      <div
        style={{
          ...base,
          opacity: interpolate(s, [0, 0.4, 1], [0, 0.7, 1]),
          letterSpacing: `calc(${trackValue} + ${extra}em)`,
        }}
      >
        {children}
      </div>
    );
  }

  // 'rise' — the default. Comes up from under a clipped baseline.
  return (
    <div style={{overflow: 'hidden', paddingBottom: '0.06em'}}>
      <div
        style={{
          ...base,
          transform: `translateY(${interpolate(s, [0, 1], [110, 0])}%)`,
        }}
      >
        {children}
      </div>
    </div>
  );
};

/**
 * A thin rule that draws itself outward from the centre — used to separate
 * lines in the lockup and to underline the year cards.
 */
export const RuleLine: React.FC<{
  delay?: number;
  color?: string;
  widthPercent?: number;
  thickness?: number;
}> = ({delay = 0, color = palette.goldTrophy, widthPercent = 22, thickness = 0.22}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const {u} = useLayout();
  const s = spring({frame: frame - delay, fps, config: springs.settle, durationInFrames: 30});

  return (
    <div
      style={{
        width: `${widthPercent * s}%`,
        height: u(thickness),
        backgroundColor: color,
        alignSelf: 'center',
      }}
    />
  );
};

/**
 * Small all-caps eyebrow label with a leading tick — the sub-lines under
 * years and nation names.
 */
export const Eyebrow: React.FC<{
  children: React.ReactNode;
  delay?: number;
  color?: string;
  tracking?: string;
}> = ({children, delay = 0, color = palette.bone, tracking = letterspacing.ultra}) => {
  const {t} = useLayout();
  return (
    <TypeLine
      delay={delay}
      font="body"
      weight={500}
      size={typeScale.caption}
      color={color}
      tracking={tracking}
      mode="fade"
      style={{opacity: 0.86, fontSize: t(typeScale.caption)}}
    >
      {children}
    </TypeLine>
  );
};
