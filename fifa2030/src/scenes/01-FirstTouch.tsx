import {
  AbsoluteFill,
  Easing,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import {useLayout} from '../config/layout';
import {fontStacks, letterspacing, palette, springs, typeScale} from '../config/theme';
import {GoldParticles, Shockwave} from '../components/GoldParticles';
import {LensFlare} from '../components/CameraRealism';
import {useScoreAmplitude} from '../audio';

/**
 * SHOT 01 — BLACK / FIRST TOUCH (0:00 – 0:06 | frames 0–180)
 *
 * Pure black. One ball in a pool of light. A foot enters and touches it, and
 * on the touch a shockwave of gold goes out and 1930 burns in.
 *
 * The touch lands on frame 46 — beat 3 of the first bar, so the whole film
 * hangs off the same grid from its first event.
 *
 *   frames   0– 26  black, then the pool of light finds the ball
 *   frames  26– 46  the foot enters from frame left
 *   frame      46   CONTACT — particles, shockwave, the ball moves
 *   frames  50– 96  1930 presses in, letterpress
 *   frames  96–150  "Montevideo, Uruguay"
 *   frames 150–180  fall away into the 1930 stadium
 */

const TOUCH = 46;

/**
 * Ball, boot and ground, drawn in ONE coordinate space.
 *
 * They were originally separate absolutely-positioned elements, and the boot
 * never actually reached the ball — the contact is the entire shot, so the two
 * cannot live in coordinate systems that only agree by arithmetic luck. The
 * ball sits at (100, 62); the boot's toe travels to exactly its left edge.
 */
/** Motes turning in the shaft of light. Fixed layout, so they never re-seed. */
const DUST = Array.from({length: 46}, (_, i) => {
  const h = (n: number) => {
    const x = Math.sin((i + 1) * n) * 43758.5453;
    return x - Math.floor(x);
  };
  return {
    x: (h(12.9) - 0.5) * 66,
    r: 0.22 + h(78.2) ** 2 * 0.5,
    speed: 0.03 + h(37.7) * 0.05,
    phase: h(93.1),
    sway: 1.5 + h(15.3) * 4,
    alpha: 0.25 + h(51.7) * 0.5,
  };
});

const CONTACT_W = 200;
const CONTACT_H = 100;
const BALL = {x: 100, y: 62, r: 11};

const Boot: React.FC<{approach: number; recoil: number; withdraw: number}> = ({
  approach,
  recoil,
  withdraw,
}) => {
  // Toe lands on the ball's left edge at approach = 1, follows through, then
  // leaves. A boot that plants and stays reads as a prop, not a player.
  const x = interpolate(approach, [0, 1], [-46, 0]) + recoil * 5.5 - withdraw * 62;
  const lift = interpolate(approach, [0, 1], [7, 0]) - recoil * 2.5 + withdraw * 6;

  return (
    <g transform={`translate(${x} ${lift})`} opacity={1 - withdraw * 0.9}>
      {/* Shin. */}
      <path
        d="M56,6 L64,7 L67,52 L58,53 Z"
        fill={palette.ink}
        stroke={palette.bone}
        strokeWidth="0.7"
        strokeLinejoin="round"
      />
      {/* Boot: heel at 58, toe reaching the ball's left edge at 89. */}
      <path
        d="M58,53 L67,52 C74,52 83,56 88,60 C90,62 89,66 85,66 L61,66 C58,66 56,64 56,60 Z"
        fill={palette.ink}
        stroke={palette.bone}
        strokeWidth="0.7"
        strokeLinejoin="round"
      />
      {/* Studs. */}
      {[60, 66, 72, 78].map((sx) => (
        <rect key={sx} x={sx} y="66" width="1.8" height="1.7" fill={palette.bone} opacity={0.5} />
      ))}
      {/* Abstracted boot stripes — the language of a boot, not a brand. */}
      {[0, 1, 2].map((i) => (
        <line
          key={i}
          x1={64 + i * 3}
          y1={56 + i * 0.9}
          x2={68 + i * 3}
          y2={61 + i * 0.9}
          stroke={palette.bone}
          strokeWidth="0.5"
          opacity={0.38}
        />
      ))}
    </g>
  );
};

const ContactStage: React.FC<{
  approach: number;
  recoil: number;
  withdraw: number;
  travel: number;
  spin: number;
  light: number;
  dustTime: number;
}> = ({approach, recoil, withdraw, travel, spin, light, dustTime}) => (
  <svg
    viewBox={`0 0 ${CONTACT_W} ${CONTACT_H}`}
    width="100%"
    height="100%"
    preserveAspectRatio="xMidYMid meet"
  >
    <defs>
      <radialGradient id="pool" cx="50%" cy="62%" r="34%">
        <stop offset="0%" stopColor={palette.bone} stopOpacity={0.22} />
        <stop offset="52%" stopColor={palette.pitchDeep} stopOpacity={0.16} />
        <stop offset="100%" stopColor="#000000" stopOpacity="0" />
      </radialGradient>
      {/* A hard-edged polygon reads as a triangle, not as light. */}
      <filter id="beamSoft" x="-40%" y="-20%" width="180%" height="140%">
        <feGaussianBlur stdDeviation="4.5" />
      </filter>
      <linearGradient id="beam" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stopColor={palette.bone} stopOpacity="0.16" />
        <stop offset="70%" stopColor={palette.bone} stopOpacity="0.05" />
        <stop offset="100%" stopColor={palette.bone} stopOpacity="0" />
      </linearGradient>
      <radialGradient id="ballLight" cx="34%" cy="28%" r="76%">
        <stop offset="0%" stopColor="#ffffff" stopOpacity="0.5" />
        <stop offset="60%" stopColor="#000000" stopOpacity="0.1" />
        <stop offset="100%" stopColor="#000000" stopOpacity="0.6" />
      </radialGradient>
    </defs>

    {/* A shaft of light from above, and the dust turning inside it. Pure black
        with one object in it reads as a still frame; the drifting motes are
        what make the opening feel like a held breath rather than a freeze. */}
    <path
      d={`M${BALL.x - 17},-6 L${BALL.x + 17},-6 L${BALL.x + 42},${CONTACT_H} L${
        BALL.x - 42
      },${CONTACT_H} Z`}
      fill="url(#beam)"
      filter="url(#beamSoft)"
      opacity={light * 0.55}
    />
    <rect x="0" y="0" width={CONTACT_W} height={CONTACT_H} fill="url(#pool)" opacity={light} />
    {DUST.map((d, i) => {
      const drift = (dustTime * d.speed + d.phase) % 1;
      const y = CONTACT_H * 0.94 - drift * CONTACT_H * 0.85;
      const x = BALL.x + d.x + Math.sin(drift * Math.PI * 2 + d.phase * 9) * d.sway;
      return (
        <circle
          key={i}
          cx={x}
          cy={y}
          r={d.r}
          fill={palette.bone}
          opacity={light * d.alpha * Math.sin(drift * Math.PI) * 0.9}
        />
      );
    })}

    {/* Contact shadow, tightening as the ball settles. */}
    <ellipse
      cx={BALL.x + travel * 78}
      cy={BALL.y + BALL.r}
      rx={BALL.r * 1.2}
      ry={BALL.r * 0.22}
      fill="#000000"
      opacity={0.6 * light}
    />

    <Boot approach={approach} recoil={recoil} withdraw={withdraw} />

    <g
      transform={`translate(${BALL.x + travel * 78} ${BALL.y}) rotate(${spin})`}
      opacity={light * Math.max(0, 1 - Math.max(0, travel - 0.7) * 3.4)}
    >
      <circle cx="0" cy="0" r={BALL.r} fill={palette.bone} />
      <circle cx="0" cy="0" r={BALL.r} fill="url(#ballLight)" />
      {/* Panels, drawn — never a photograph of a ball. */}
      <polygon
        points={`0,${-BALL.r * 0.42} ${BALL.r * 0.4},${-BALL.r * 0.13} ${BALL.r * 0.24},${
          BALL.r * 0.33
        } ${-BALL.r * 0.24},${BALL.r * 0.33} ${-BALL.r * 0.4},${-BALL.r * 0.13}`}
        fill={palette.ink}
      />
      {[0, 72, 144, 216, 288].map((a) => (
        <polygon
          key={a}
          points={`0,${-BALL.r} ${BALL.r * 0.26},${-BALL.r * 0.74} ${BALL.r * 0.13},${
            -BALL.r * 0.48
          } ${-BALL.r * 0.13},${-BALL.r * 0.48} ${-BALL.r * 0.26},${-BALL.r * 0.74}`}
          fill={palette.ink}
          opacity={0.85}
          transform={`rotate(${a})`}
        />
      ))}
    </g>
  </svg>
);

export const FirstTouch: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const {u, t, width, height} = useLayout();

  /**
   * Where the ball actually sits in the frame, derived from the contact stage's
   * own projection rather than guessed. The shockwave and the particle burst
   * have to originate from the ball in all three aspect ratios, and a
   * hardcoded fraction is only ever right for one of them.
   */
  const stageScale = Math.min(width / CONTACT_W, height / CONTACT_H);
  const ballOrigin = {
    x: ((width - CONTACT_W * stageScale) / 2 + BALL.x * stageScale) / width,
    y: ((height - CONTACT_H * stageScale) / 2 + BALL.y * stageScale) / height,
  };

  // The burst reads the score's actual amplitude at the moment of contact, so
  // picture and sound are locked rather than merely aligned.
  const amplitude = useScoreAmplitude(TOUCH);

  const approach = spring({
    frame: frame - 26,
    fps,
    config: {damping: 200, mass: 0.9, stiffness: 130},
    durationInFrames: 22,
  });
  const recoil = spring({frame: frame - TOUCH, fps, config: springs.pop, durationInFrames: 30});

  // The pool of light finds the ball before anything else happens.
  const light = interpolate(frame, [6, 30], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.bezier(0.4, 0, 0.3, 1),
  });

  // The ball is struck and rolls out of frame.
  const ballTravel = interpolate(frame, [TOUCH, TOUCH + 54], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.bezier(0.12, 0.7, 0.3, 1),
  });
  const ballSpin = ballTravel * 900;

  // The boot leaves the frame once the follow-through has read.
  const withdraw = interpolate(frame, [TOUCH + 26, TOUCH + 54], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.bezier(0.5, 0, 0.7, 1),
  });

  const yearPress = spring({
    frame: frame - (TOUCH + 4),
    fps,
    config: springs.slam,
    durationInFrames: 24,
  });

  const outro = interpolate(frame, [156, 180], [1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  return (
    <AbsoluteFill style={{backgroundColor: '#000000', opacity: outro}}>
      <AbsoluteFill style={{transform: `scale(${1 + frame * 0.00055})`}}>
        <ContactStage
          approach={approach}
          recoil={recoil}
          withdraw={withdraw}
          travel={ballTravel}
          spin={ballSpin}
          light={light}
          dustTime={frame / fps}
        />
      </AbsoluteFill>

      {/* CONTACT. */}
      <Shockwave
        triggerFrame={TOUCH}
        origin={ballOrigin}
        intensity={0.8 + amplitude * 0.7}
        maxRadius={64}
        duration={44}
      />
      <GoldParticles
        triggerFrame={TOUCH}
        origin={ballOrigin}
        count={190}
        spread={54}
        // Burst scale is driven by the score's amplitude at the touch.
        intensity={0.75 + amplitude * 0.9}
        gravity={0.42}
        lifetime={74}
      />

      {/* The flare arrives WITH the burst rather than sitting on top of it —
          same trigger frame, same rise-and-fall envelope. */}
      <LensFlare
        origin={ballOrigin}
        strength={interpolate(frame, [TOUCH, TOUCH + 5, TOUCH + 30, TOUCH + 60], [0, 1, 0.55, 0], {
          extrapolateLeft: 'clamp',
          extrapolateRight: 'clamp',
        })}
      />

      {/* 1930, pressed in. */}
      <AbsoluteFill
        style={{
          alignItems: 'center',
          justifyContent: 'center',
          flexDirection: 'column',
          gap: u(3.2),
          pointerEvents: 'none',
        }}
      >
        <div
          style={{
            fontFamily: fontStacks.display,
            fontSize: t(typeScale.hero),
            lineHeight: 0.92,
            color: palette.goldTrophy,
            fontVariantNumeric: 'tabular-nums',
            fontFeatureSettings: '"tnum" 1',
            letterSpacing: letterspacing.tight,
            opacity: interpolate(yearPress, [0, 0.18, 1], [0, 1, 1]),
            transform: `scale(${interpolate(yearPress, [0, 1], [1.3, 1])})`,
            // Letterpress: pressed into the frame, not laid on top of it.
            textShadow: `0 ${u(0.34)}px 0 rgba(0,0,0,0.85), 0 ${u(-0.12)}px 0 rgba(242,217,152,${
              0.3 * yearPress
            }), 0 ${u(0.9)}px ${u(3.4)}px rgba(212,167,60,0.25)`,
            mixBlendMode: 'screen',
          }}
        >
          1930
        </div>

        <div
          style={{
            fontFamily: fontStacks.body,
            fontSize: t(typeScale.subtitle),
            fontWeight: 500,
            letterSpacing: letterspacing.ultra,
            textTransform: 'uppercase',
            color: palette.bone,
            opacity: interpolate(frame, [96, 116, 150, 164], [0, 0.85, 0.85, 0], {
              extrapolateLeft: 'clamp',
              extrapolateRight: 'clamp',
            }),
            textAlign: 'center',
          }}
        >
          Montevideo, Uruguay
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
