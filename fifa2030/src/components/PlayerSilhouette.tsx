import {Img, interpolate, random, useCurrentFrame} from 'remotion';
import {samplePose, type PlayerSlot, type Pose} from '../config/players';
import {palette} from '../config/theme';

/**
 * Renders a player moment.
 *
 * NO REAL PLAYER IS DEPICTED. The figure is a high-contrast silhouette driven
 * entirely by `PlayerSlot.poseKeyframes` — readable by action, posture and
 * jersey number, never by face. If a slot carries an `assetSrc`, that licensed
 * asset renders instead and nothing else in the film changes.
 *
 * See `src/config/players.ts` for the swap points.
 */

type Props = {
  slot: PlayerSlot;
  /** 0 → 1 through the action. */
  progress: number;
  /** Show the ball and its trail. */
  showBall?: boolean;
  /** Duotone linework instead of solid fill — used for the Shot 03 hero freezes. */
  linework?: boolean;
  figureColor?: string;
  markColor?: string;
  /** Draw supporting figures (defenders peeling off, team-mates). */
  supporting?: boolean;
};

const V = 100;

/** Thickness of each limb, in pose-space units. */
const LIMB = {
  torso: 9.5,
  upperArm: 4.2,
  forearm: 3.4,
  thigh: 6,
  shin: 4.6,
};

const seg = (
  a: readonly [number, number],
  b: readonly [number, number],
  width: number,
  color: string,
  opacity = 1,
  key?: string,
) => (
  <line
    key={key}
    x1={a[0]}
    y1={a[1]}
    x2={b[0]}
    y2={b[1]}
    stroke={color}
    strokeWidth={width}
    strokeLinecap="round"
    opacity={opacity}
  />
);

const Figure: React.FC<{
  pose: Pose;
  color: string;
  opacity?: number;
  scale?: number;
  outline?: boolean;
}> = ({pose, color, opacity = 1, scale = 1, outline = false}) => {
  const w = (n: number) => n * scale;
  const stroke = outline ? 'none' : color;
  const fill = outline ? 'none' : color;

  return (
    <g opacity={opacity} {...(outline ? {stroke: color, fill: 'none', strokeWidth: 1.4} : {})}>
      {/* Legs first so the torso sits over the hips. */}
      {seg(pose.hip, pose.kneeL, w(LIMB.thigh), stroke, 1, 'thighL')}
      {seg(pose.kneeL, pose.footL, w(LIMB.shin), stroke, 1, 'shinL')}
      {seg(pose.hip, pose.kneeR, w(LIMB.thigh), stroke, 1, 'thighR')}
      {seg(pose.kneeR, pose.footR, w(LIMB.shin), stroke, 1, 'shinR')}

      {/* Torso as a tapered quad from shoulders to hip. */}
      <path
        d={`M${pose.shoulderL[0]},${pose.shoulderL[1]}
            L${pose.shoulderR[0]},${pose.shoulderR[1]}
            L${pose.hip[0] + w(3.4)},${pose.hip[1]}
            L${pose.hip[0] - w(3.4)},${pose.hip[1]} Z`}
        fill={fill}
      />
      {seg(pose.neck, pose.hip, w(LIMB.torso), stroke, 1, 'spine')}

      {seg(pose.shoulderL, pose.elbowL, w(LIMB.upperArm), stroke, 1, 'upperL')}
      {seg(pose.elbowL, pose.handL, w(LIMB.forearm), stroke, 1, 'foreL')}
      {seg(pose.shoulderR, pose.elbowR, w(LIMB.upperArm), stroke, 1, 'upperR')}
      {seg(pose.elbowR, pose.handR, w(LIMB.forearm), stroke, 1, 'foreR')}

      {seg(pose.neck, pose.head, w(5), stroke, 1, 'neck')}
      <circle cx={pose.head[0]} cy={pose.head[1]} r={w(5.4)} fill={fill} />
    </g>
  );
};

export const PlayerSilhouette: React.FC<Props> = ({
  slot,
  progress,
  showBall = true,
  linework = false,
  figureColor,
  markColor,
  supporting = true,
}) => {
  const frame = useCurrentFrame();
  const pose = samplePose(slot.poseKeyframes, progress);
  const figure = figureColor ?? slot.colorway.figure;
  const mark = markColor ?? slot.colorway.mark;

  // Motion trail: the same pose sampled slightly in the past, ghosted back.
  const trail = [0.055, 0.11, 0.17].map((lag) => ({
    lag,
    pose: samplePose(slot.poseKeyframes, Math.max(0, progress - lag)),
  }));

  // Ball trail — the gold arc Portugal's strike leaves behind, and the path
  // every other ball takes through its moment.
  const ballTrail = Array.from({length: 22}, (_, i) => {
    const t = (progress * (i / 21)) as number;
    return samplePose(slot.poseKeyframes, t).ball;
  });

  if (slot.assetSrc) {
    // SWAP POINT: licensed player asset replaces the vector figure entirely.
    return (
      <svg viewBox={`0 0 ${V} ${V}`} width="100%" height="100%" preserveAspectRatio="xMidYMid meet">
        <foreignObject x="0" y="0" width={V} height={V}>
          <Img src={slot.assetSrc} style={{width: '100%', height: '100%', objectFit: 'contain'}} />
        </foreignObject>
      </svg>
    );
  }

  return (
    <svg viewBox={`0 0 ${V} ${V}`} width="100%" height="100%" preserveAspectRatio="xMidYMid meet">
      {/* Ground shadow anchors the figure so it isn't floating. */}
      <ellipse
        cx={(pose.footL[0] + pose.footR[0]) / 2}
        cy={97}
        rx={11}
        ry={2}
        fill={palette.ink}
        opacity={0.28}
      />

      {/* Defenders / team-mates, well behind and much lower contrast: the
          hero figure must stay the only thing the eye lands on. */}
      {supporting && slot.supportingFigures
        ? Array.from({length: slot.supportingFigures}, (_, i) => {
            const side = i % 2 === 0 ? 1 : -1;
            const off = side * (26 + random(`sup-${slot.nation}-${i}`) * 26);
            const depth = 0.72 + random(`sd-${slot.nation}-${i}`) * 0.18;
            // Supporting figures lag the hero's pose — they are reacting to it.
            const lag = 0.18 + i * 0.06;
            const sp = samplePose(slot.poseKeyframes, Math.max(0, progress - lag));
            return (
              <g
                key={i}
                transform={`translate(${off} ${(1 - depth) * 34}) scale(${depth}) translate(${
                  (1 - depth) * 50
                } ${(1 - depth) * 50})`}
                opacity={0.16}
              >
                <Figure pose={sp} color={figure} scale={1} />
              </g>
            );
          })
        : null}

      {/* Motion ghosts. */}
      {trail.map(({lag, pose: p}, i) => (
        <g key={lag}>
          <Figure pose={p} color={figure} opacity={0.1 - i * 0.025} />
        </g>
      ))}

      {showBall ? (
        <>
          <path
            d={ballTrail
              .map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0].toFixed(2)},${p[1].toFixed(2)}`)
              .join(' ')}
            fill="none"
            stroke={palette.goldTrophy}
            strokeWidth={1.4}
            strokeLinecap="round"
            opacity={0.7}
          />
          <circle cx={pose.ball[0]} cy={pose.ball[1]} r={4.4} fill={mark} />
          <circle
            cx={pose.ball[0]}
            cy={pose.ball[1]}
            r={4.4}
            fill="none"
            stroke={palette.goldLight}
            strokeWidth={0.7}
            opacity={0.8}
          />
        </>
      ) : null}

      <Figure pose={pose} color={figure} outline={linework} />
      {linework ? <Figure pose={pose} color={figure} opacity={0.14} /> : null}

      {/* Jersey number — the only identification this film uses. */}
      <text
        x={(pose.neck[0] + pose.hip[0]) / 2}
        y={(pose.neck[1] + pose.hip[1]) / 2 + 3}
        fontSize={9}
        fontFamily='"Anton", sans-serif'
        fill={mark}
        textAnchor="middle"
        opacity={interpolate(frame, [0, 8], [0, 0.9], {extrapolateRight: 'clamp'})}
        style={{fontVariantNumeric: 'tabular-nums'}}
      >
        {slot.jerseyNumber}
      </text>
    </svg>
  );
};
