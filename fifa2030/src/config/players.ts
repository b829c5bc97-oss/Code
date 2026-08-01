/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  PLAYER SLOTS — the single swap point for all on-pitch human content
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * No real, identifiable footballer is depicted anywhere in this film. Player
 * image rights are licensed separately from tournament rights and are the most
 * common legal blocker on a sequence like this, so every player is rendered as
 * a high-contrast stylised silhouette built from the pose keyframes below —
 * readable by ACTION, POSTURE and JERSEY NUMBER, never by face.
 *
 * To drop in licensed player assets later, edit THIS FILE ONLY. Give a slot an
 * `assetSrc` and `PlayerSilhouette` renders that image instead of the vector
 * figure; no scene component changes. `jerseyNumber`, `colorway` and
 * `signatureAction` are likewise data — swap them without touching a scene.
 *
 * Pose space: a 0–100 × 0–100 box, y increasing downward, ground plane at
 * y ≈ 96. Keyframes are interpolated with a spring in `PlayerSilhouette`.
 */

export type Joint = readonly [number, number];

export type Pose = {
  head: Joint;
  neck: Joint;
  hip: Joint;
  shoulderL: Joint;
  elbowL: Joint;
  handL: Joint;
  shoulderR: Joint;
  elbowR: Joint;
  handR: Joint;
  kneeL: Joint;
  footL: Joint;
  kneeR: Joint;
  footR: Joint;
  /** Ball position for this keyframe. */
  ball: Joint;
};

export type PoseKeyframe = {
  /** Normalised time within the player moment, 0 → 1. */
  t: number;
  pose: Pose;
};

export type Colorway = {
  /** Field the silhouette is read against. */
  field: string;
  /** The silhouette body fill. */
  figure: string;
  /** Jersey number + ball trail. */
  mark: string;
};

export type PlayerSlot = {
  nation: string;
  jerseyNumber: number;
  /** Human-readable description of the moment — also used as the on-screen caption. */
  signatureAction: string;
  poseKeyframes: PoseKeyframe[];
  colorway: Colorway;
  /**
   * SWAP POINT: set to a path under `public/players/` to replace the vector
   * silhouette with a licensed asset (PNG/SVG with alpha, ~1000×1000).
   */
  assetSrc?: string;
  /** Extra silhouettes rendered behind the hero figure (defenders, team-mates). */
  supportingFigures?: number;
};

const kf = (t: number, pose: Pose): PoseKeyframe => ({t, pose});

export const players: Record<string, PlayerSlot> = {
  morocco: {
    nation: 'morocco',
    jerseyNumber: 7,
    signatureAction: 'Cutting inside from the right',
    supportingFigures: 2,
    colorway: {field: '#C1272D', figure: '#F4EFE6', mark: '#006233'},
    poseKeyframes: [
      kf(0, {
        head: [52, 13], neck: [52, 23], hip: [54, 52],
        shoulderL: [46, 27], elbowL: [38, 36], handL: [32, 30],
        shoulderR: [60, 27], elbowR: [68, 40], handR: [74, 48],
        kneeL: [44, 70], footL: [38, 84], kneeR: [62, 72], footR: [70, 94],
        ball: [30, 90],
      }),
      kf(0.34, {
        head: [44, 16], neck: [45, 26], hip: [52, 54],
        shoulderL: [39, 30], elbowL: [30, 36], handL: [23, 34],
        shoulderR: [52, 30], elbowR: [60, 44], handR: [66, 54],
        kneeL: [44, 74], footL: [40, 94], kneeR: [66, 70], footR: [76, 92],
        ball: [34, 88],
      }),
      kf(0.67, {
        head: [40, 18], neck: [41, 28], hip: [50, 56],
        shoulderL: [35, 32], elbowL: [26, 40], handL: [19, 44],
        shoulderR: [48, 31], elbowR: [58, 46], handR: [63, 56],
        kneeL: [38, 74], footL: [30, 88], kneeR: [60, 74], footR: [68, 94],
        ball: [26, 90],
      }),
      kf(1, {
        head: [34, 13], neck: [35, 23], hip: [40, 52],
        shoulderL: [29, 27], elbowL: [21, 34], handL: [15, 30],
        shoulderR: [42, 27], elbowR: [50, 38], handR: [57, 44],
        kneeL: [30, 70], footL: [22, 82], kneeR: [48, 72], footR: [54, 94],
        ball: [14, 88],
      }),
    ],
  },

  spain: {
    nation: 'spain',
    jerseyNumber: 6,
    signatureAction: 'One touch, and the ball never stops',
    supportingFigures: 2,
    colorway: {field: '#AA151B', figure: '#F4EFE6', mark: '#F1BF00'},
    poseKeyframes: [
      kf(0, {
        head: [48, 14], neck: [48, 24], hip: [50, 52],
        shoulderL: [42, 28], elbowL: [36, 38], handL: [32, 48],
        shoulderR: [55, 28], elbowR: [62, 38], handR: [68, 46],
        kneeL: [44, 72], footL: [40, 92], kneeR: [56, 70], footR: [60, 88],
        ball: [86, 80],
      }),
      kf(0.4, {
        head: [46, 14], neck: [46, 24], hip: [50, 52],
        shoulderL: [38, 28], elbowL: [28, 34], handL: [20, 32],
        shoulderR: [54, 29], elbowR: [64, 42], handR: [72, 40],
        kneeL: [44, 72], footL: [42, 94], kneeR: [62, 68], footR: [74, 80],
        ball: [66, 86],
      }),
      kf(0.7, {
        head: [45, 15], neck: [45, 25], hip: [49, 52],
        shoulderL: [37, 29], elbowL: [26, 36], handL: [18, 36],
        shoulderR: [53, 30], elbowR: [60, 44], handR: [66, 52],
        kneeL: [44, 72], footL: [44, 94], kneeR: [54, 68], footR: [44, 80],
        ball: [34, 84],
      }),
      kf(1, {
        head: [45, 14], neck: [45, 24], hip: [48, 52],
        shoulderL: [37, 28], elbowL: [27, 35], handL: [20, 32],
        shoulderR: [53, 29], elbowR: [58, 42], handR: [62, 52],
        kneeL: [46, 72], footL: [48, 94], kneeR: [44, 66], footR: [30, 72],
        ball: [6, 78],
      }),
    ],
  },

  portugal: {
    nation: 'portugal',
    jerseyNumber: 7,
    signatureAction: 'Struck from thirty metres',
    supportingFigures: 1,
    colorway: {field: '#046A38', figure: '#F4EFE6', mark: '#D4A73C'},
    poseKeyframes: [
      kf(0, {
        head: [50, 14], neck: [50, 24], hip: [52, 52],
        shoulderL: [44, 28], elbowL: [36, 36], handL: [30, 32],
        shoulderR: [57, 28], elbowR: [64, 40], handR: [70, 48],
        kneeL: [46, 70], footL: [40, 86], kneeR: [60, 72], footR: [66, 94],
        ball: [30, 88],
      }),
      kf(0.35, {
        head: [54, 16], neck: [53, 26], hip: [52, 52],
        shoulderL: [44, 29], elbowL: [30, 30], handL: [20, 28],
        shoulderR: [62, 30], elbowR: [74, 38], handR: [84, 42],
        kneeL: [44, 72], footL: [40, 94], kneeR: [68, 64], footR: [84, 72],
        ball: [26, 88],
      }),
      kf(0.6, {
        head: [48, 15], neck: [48, 25], hip: [50, 50],
        shoulderL: [38, 28], elbowL: [24, 32], handL: [14, 36],
        shoulderR: [58, 30], elbowR: [70, 42], handR: [78, 54],
        kneeL: [44, 70], footL: [42, 94], kneeR: [48, 62], footR: [30, 80],
        ball: [22, 84],
      }),
      kf(1, {
        head: [44, 12], neck: [44, 22], hip: [46, 48],
        shoulderL: [34, 26], elbowL: [22, 30], handL: [12, 34],
        shoulderR: [54, 27], elbowR: [66, 38], handR: [72, 50],
        kneeL: [46, 66], footL: [54, 86], kneeR: [34, 58], footR: [16, 62],
        ball: [-2, 58],
      }),
    ],
  },

  uruguay: {
    nation: 'uruguay',
    jerseyNumber: 9,
    signatureAction: 'Garra charrúa — cleared off the line',
    supportingFigures: 1,
    colorway: {field: '#4C9DD8', figure: '#F4EFE6', mark: '#0A1F14'},
    poseKeyframes: [
      kf(0, {
        head: [56, 14], neck: [56, 24], hip: [58, 52],
        shoulderL: [50, 28], elbowL: [42, 36], handL: [36, 32],
        shoulderR: [63, 28], elbowR: [70, 40], handR: [76, 48],
        kneeL: [48, 70], footL: [42, 84], kneeR: [66, 72], footR: [72, 94],
        ball: [16, 74],
      }),
      kf(0.35, {
        head: [48, 30], neck: [49, 38], hip: [58, 58],
        shoulderL: [43, 40], elbowL: [34, 44], handL: [26, 44],
        shoulderR: [55, 42], elbowR: [62, 52], handR: [68, 58],
        kneeL: [46, 74], footL: [34, 84], kneeR: [68, 72], footR: [78, 86],
        ball: [18, 72],
      }),
      kf(0.62, {
        head: [34, 58], neck: [38, 64], hip: [58, 76],
        shoulderL: [34, 66], elbowL: [24, 66], handL: [14, 64],
        shoulderR: [44, 70], elbowR: [52, 78], handR: [58, 86],
        kneeL: [44, 88], footL: [26, 92], kneeR: [70, 84], footR: [84, 92],
        ball: [14, 66],
      }),
      kf(1, {
        head: [30, 60], neck: [34, 66], hip: [56, 78],
        shoulderL: [30, 68], elbowL: [20, 68], handL: [10, 68],
        shoulderR: [42, 72], elbowR: [50, 80], handR: [56, 88],
        kneeL: [42, 90], footL: [24, 94], kneeR: [68, 86], footR: [84, 94],
        ball: [2, 34],
      }),
    ],
  },

  argentina: {
    nation: 'argentina',
    jerseyNumber: 10,
    signatureAction: 'Through five, and still going',
    supportingFigures: 4,
    colorway: {field: '#75AADB', figure: '#F4EFE6', mark: '#0A1F14'},
    poseKeyframes: [
      kf(0, {
        head: [54, 18], neck: [54, 27], hip: [54, 54],
        shoulderL: [48, 31], elbowL: [40, 40], handL: [34, 44],
        shoulderR: [60, 31], elbowR: [68, 42], handR: [74, 48],
        kneeL: [46, 72], footL: [40, 86], kneeR: [62, 72], footR: [68, 94],
        ball: [34, 88],
      }),
      kf(0.33, {
        head: [46, 20], neck: [47, 29], hip: [50, 56],
        shoulderL: [40, 33], elbowL: [32, 42], handL: [25, 46],
        shoulderR: [54, 33], elbowR: [62, 44], handR: [68, 52],
        kneeL: [40, 74], footL: [30, 90], kneeR: [58, 74], footR: [64, 94],
        ball: [24, 90],
      }),
      kf(0.66, {
        head: [52, 19], neck: [52, 28], hip: [54, 55],
        shoulderL: [46, 32], elbowL: [38, 42], handL: [31, 47],
        shoulderR: [59, 32], elbowR: [67, 43], handR: [73, 50],
        kneeL: [48, 73], footL: [42, 94], kneeR: [62, 73], footR: [70, 88],
        ball: [36, 90],
      }),
      kf(1, {
        head: [42, 17], neck: [43, 26], hip: [46, 53],
        shoulderL: [36, 30], elbowL: [28, 39], handL: [21, 42],
        shoulderR: [50, 30], elbowR: [58, 42], handR: [64, 50],
        kneeL: [36, 71], footL: [26, 84], kneeR: [54, 73], footR: [60, 94],
        ball: [14, 88],
      }),
    ],
  },

  paraguay: {
    nation: 'paraguay',
    jerseyNumber: 1,
    signatureAction: 'Fingertips, and nothing else',
    supportingFigures: 1,
    colorway: {field: '#0038A8', figure: '#F4EFE6', mark: '#D52B1E'},
    poseKeyframes: [
      kf(0, {
        head: [50, 20], neck: [50, 30], hip: [50, 56],
        shoulderL: [42, 33], elbowL: [34, 44], handL: [32, 54],
        shoulderR: [58, 33], elbowR: [66, 44], handR: [68, 54],
        kneeL: [44, 74], footL: [40, 94], kneeR: [56, 74], footR: [60, 94],
        ball: [92, 70],
      }),
      kf(0.3, {
        head: [58, 16], neck: [57, 26], hip: [52, 54],
        shoulderL: [48, 29], elbowL: [40, 38], handL: [36, 44],
        shoulderR: [66, 30], elbowR: [76, 26], handR: [84, 20],
        kneeL: [44, 72], footL: [38, 92], kneeR: [58, 74], footR: [64, 94],
        ball: [86, 44],
      }),
      kf(0.62, {
        head: [66, 24], neck: [63, 30], hip: [44, 46],
        shoulderL: [55, 32], elbowL: [46, 44], handL: [40, 52],
        shoulderR: [68, 34], elbowR: [80, 22], handR: [92, 12],
        kneeL: [34, 54], footL: [20, 58], kneeR: [36, 64], footR: [18, 74],
        ball: [94, 10],
      }),
      kf(1, {
        head: [70, 30], neck: [66, 35], hip: [44, 48],
        shoulderL: [58, 38], elbowL: [48, 50], handL: [42, 58],
        shoulderR: [72, 38], elbowR: [84, 28], handR: [96, 18],
        kneeL: [32, 56], footL: [16, 58], kneeR: [34, 66], footR: [14, 78],
        ball: [104, 2],
      }),
    ],
  },
};

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

const JOINTS = [
  'head', 'neck', 'hip',
  'shoulderL', 'elbowL', 'handL',
  'shoulderR', 'elbowR', 'handR',
  'kneeL', 'footL', 'kneeR', 'footR',
  'ball',
] as const;

/** Sample the pose track at normalised time `t` (0–1). */
export const samplePose = (keyframes: PoseKeyframe[], t: number): Pose => {
  const clamped = Math.max(0, Math.min(1, t));
  const first = keyframes[0];
  if (!first) throw new Error('Pose track is empty');

  let a = first;
  let b = first;
  for (let i = 0; i < keyframes.length - 1; i++) {
    const lo = keyframes[i]!;
    const hi = keyframes[i + 1]!;
    if (clamped >= lo.t && clamped <= hi.t) {
      a = lo;
      b = hi;
      break;
    }
    if (clamped > hi.t) {
      a = hi;
      b = hi;
    }
  }

  const span = b.t - a.t;
  const local = span <= 0 ? 0 : (clamped - a.t) / span;

  const out = {} as Record<(typeof JOINTS)[number], Joint>;
  for (const joint of JOINTS) {
    const pa = a.pose[joint];
    const pb = b.pose[joint];
    out[joint] = [lerp(pa[0], pb[0], local), lerp(pa[1], pb[1], local)];
  }
  return out as Pose;
};
