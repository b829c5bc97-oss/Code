import {useMemo} from 'react';
import * as THREE from 'three';
import {palette} from '../config/theme';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  REAL FOOTBALL ON THE PITCH
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * These were capsules wobbling on the spot. A stadium shot lives or dies on
 * whether the football under it looks like football, so this is now an actual
 * move: a passage of play with a build-up, a switch, an overlap, a cross and a
 * finish, and 22 players who each hold a position and react to where the ball
 * actually is.
 *
 * NO REAL PLAYER IS DEPICTED — same constraint as everywhere else in this
 * film. These are articulated stylised figures, identified by kit colour and
 * position, never by face. See `src/config/players.ts` for the swap
 * architecture.
 *
 * Every figure has a running cycle driven by its own speed, so a player who is
 * sprinting moves their legs faster than one who is jogging into space. That
 * single detail is most of what separates "footballers" from "markers sliding
 * around a pitch".
 */

const PITCH_X = 5.0; // half-length
const PITCH_Z = 3.2; // half-width

type Vec2 = {x: number; z: number};

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const ease = (t: number) => t * t * (3 - 2 * t);

/**
 * The ball's path through the move, as timed waypoints (t is 0→1 across the
 * shot). Each leg is a real pass with a real receiver.
 */
const BALL_PATH: {t: number; x: number; z: number; y: number}[] = [
  {t: 0.0, x: -3.6, z: 0.4, y: 0.08}, // played out from the back
  {t: 0.12, x: -2.6, z: -1.8, y: 0.08}, // out to the left
  {t: 0.26, x: -0.8, z: -2.2, y: 0.08}, // carried forward
  {t: 0.4, x: 0.4, z: 0.2, y: 0.5}, // switched across, lofted
  {t: 0.52, x: 1.6, z: 2.2, y: 0.08}, // right wing takes it down
  {t: 0.66, x: 3.2, z: 2.6, y: 0.08}, // overlap, driven to the byline
  {t: 0.8, x: 3.9, z: 0.6, y: 0.9}, // the cross
  {t: 0.9, x: 4.9, z: 0.0, y: 0.5}, // the finish
  {t: 1.0, x: 5.4, z: 0.0, y: 0.35}, // into the net
];

export const ballAt = (t: number): {x: number; z: number; y: number} => {
  const clamped = Math.max(0, Math.min(1, t));
  for (let i = 0; i < BALL_PATH.length - 1; i++) {
    const a = BALL_PATH[i]!;
    const b = BALL_PATH[i + 1]!;
    if (clamped >= a.t && clamped <= b.t) {
      const local = (clamped - a.t) / (b.t - a.t);
      // A pass leaves fast and arrives slow.
      const e = 1 - Math.pow(1 - local, 1.8);
      return {
        x: lerp(a.x, b.x, e),
        z: lerp(a.z, b.z, e),
        // Lofted passes arc; ground passes stay down.
        y: lerp(a.y, b.y, e) + Math.sin(local * Math.PI) * (Math.max(a.y, b.y) > 0.3 ? 0.55 : 0.03),
      };
    }
  }
  const last = BALL_PATH[BALL_PATH.length - 1]!;
  return {x: last.x, z: last.z, y: last.y};
};

/** 4-3-3, in pitch coordinates, for the team attacking +x. */
const HOME_SHAPE: Vec2[] = [
  {x: -4.6, z: 0},
  {x: -3.5, z: -2.2}, {x: -3.6, z: -0.8}, {x: -3.6, z: 0.8}, {x: -3.5, z: 2.2},
  {x: -1.9, z: -1.5}, {x: -2.1, z: 0}, {x: -1.9, z: 1.5},
  {x: -0.2, z: -2.4}, {x: 0.2, z: 0}, {x: -0.2, z: 2.4},
];

/** The defending side, mirrored and pushed back. */
const AWAY_SHAPE: Vec2[] = HOME_SHAPE.map((p) => ({x: -p.x * 0.82, z: -p.z}));

/**
 * Where a player actually is at time t.
 *
 * Players do not sit on their formation spot. The whole shape shifts toward
 * the ball, players near it press or offer, and the attacking line pushes up
 * as the move progresses — which is what makes a formation look like a team.
 */
const playerAt = (
  home: Vec2,
  index: number,
  t: number,
  isHome: boolean,
): {x: number; z: number; speed: number} => {
  const ball = ballAt(t);
  const push = ease(Math.min(1, t * 1.15)) * (isHome ? 2.4 : 1.5);

  const baseX = home.x + (isHome ? push : -push * 0.5);
  const baseZ = home.z;

  // Attraction to the ball falls off with distance — the near players shift a
  // lot, the far side holds shape.
  const dist = Math.hypot(ball.x - baseX, ball.z - baseZ);
  const pull = Math.max(0, 1 - dist / 5.5) ** 1.6 * (isHome ? 1.5 : 1.9);
  // Goalkeepers hold their line.
  const isKeeper = index === 0;
  const k = isKeeper ? 0.12 : 1;

  const x = baseX + (ball.x - baseX) * pull * 0.42 * k;
  const z = baseZ + (ball.z - baseZ) * pull * 0.5 * k;

  // Speed from the derivative — used to drive the running cycle.
  const dt = 0.01;
  const ballNext = ballAt(Math.min(1, t + dt));
  const distNext = Math.hypot(ballNext.x - baseX, ballNext.z - baseZ);
  const pullNext = Math.max(0, 1 - distNext / 5.5) ** 1.6 * (isHome ? 1.5 : 1.9);
  const xNext = baseX + (ballNext.x - baseX) * pullNext * 0.42 * k;
  const zNext = baseZ + (ballNext.z - baseZ) * pullNext * 0.5 * k;
  const speed = Math.hypot(xNext - x, zNext - z) / dt;

  return {
    x: Math.max(-PITCH_X - 0.5, Math.min(PITCH_X + 0.5, x)),
    z: Math.max(-PITCH_Z - 0.3, Math.min(PITCH_Z + 0.3, z)),
    speed,
  };
};

/**
 * One articulated figure — torso, head, arms, thighs, shins, shadow.
 *
 * Rewritten from scaled boxes to capsules on a real skeleton. Two changes do
 * almost all the work of making these read as people rather than as markers:
 *
 * 1. LIT MATERIALS. Boxes with MeshBasicMaterial are flat colour with no
 *    shading, which is why the old figures looked like game pieces — nothing
 *    on them told you they had volume. Phong with a directional key gives
 *    every limb a lit side and a shadow side.
 *
 * 2. REAL JOINTS. Limbs are now placed BETWEEN computed joint positions via
 *    forward kinematics, so the knee actually bends and the lower leg trails
 *    the thigh through the stride. Rotating a whole leg rigidly about the hip
 *    is the single biggest tell of a cheap run cycle.
 *
 * Kit is split into shirt / shorts / socks, which is most of what makes a
 * football figure legible at distance.
 */

type Limbs = {
  torso: THREE.Mesh;
  head: THREE.Mesh;
  armL: THREE.Mesh;
  armR: THREE.Mesh;
  thighL: THREE.Mesh;
  thighR: THREE.Mesh;
  shinL: THREE.Mesh;
  shinR: THREE.Mesh;
  shadow: THREE.Mesh;
};

const GEO = {
  torso: new THREE.CapsuleGeometry(0.032, 0.062, 4, 10),
  head: new THREE.SphereGeometry(0.026, 12, 10),
  arm: new THREE.CapsuleGeometry(0.0115, 0.055, 3, 8),
  thigh: new THREE.CapsuleGeometry(0.0165, 0.055, 3, 8),
  shin: new THREE.CapsuleGeometry(0.013, 0.058, 3, 8),
  shadow: new THREE.CircleGeometry(0.05, 14),
};

/** Segment lengths, in world units. Total standing height ≈ 0.26. */
const SEG = {hip: 0.115, thigh: 0.058, shin: 0.058, torso: 0.075, arm: 0.062};

const V_UP = new THREE.Vector3(0, 1, 0);
const scratchA = new THREE.Vector3();
const scratchB = new THREE.Vector3();
const scratchDir = new THREE.Vector3();
const scratchQuat = new THREE.Quaternion();

/**
 * Place a capsule so it spans from `a` to `b`. The capsule's own axis is Y, so
 * this is a rotation from +Y onto the segment direction plus a midpoint.
 */
const spanLimb = (mesh: THREE.Mesh, a: THREE.Vector3, b: THREE.Vector3) => {
  scratchDir.subVectors(b, a);
  const len = scratchDir.length() || 0.0001;
  mesh.position.copy(a).add(b).multiplyScalar(0.5);
  scratchDir.divideScalar(len);
  scratchQuat.setFromUnitVectors(V_UP, scratchDir);
  mesh.quaternion.copy(scratchQuat);
};

const buildTeam = (
  count: number,
  kit: string,
  shorts: string,
  skin: string,
): THREE.Group => {
  const group = new THREE.Group();

  const shirtMat = new THREE.MeshPhongMaterial({
    color: new THREE.Color(kit),
    shininess: 18,
    specular: new THREE.Color('#2A2A2A'),
  });
  const shortsMat = new THREE.MeshPhongMaterial({
    color: new THREE.Color(shorts),
    shininess: 14,
    specular: new THREE.Color('#222222'),
  });
  const skinMat = new THREE.MeshPhongMaterial({
    color: new THREE.Color(skin),
    shininess: 8,
  });
  const shadowMat = new THREE.MeshBasicMaterial({
    color: '#000000',
    transparent: true,
    opacity: 0.32,
  });

  for (let i = 0; i < count; i++) {
    const p = new THREE.Group();
    const parts = [
      new THREE.Mesh(GEO.torso, shirtMat),
      new THREE.Mesh(GEO.head, skinMat),
      new THREE.Mesh(GEO.arm, skinMat),
      new THREE.Mesh(GEO.arm, skinMat),
      new THREE.Mesh(GEO.thigh, shortsMat),
      new THREE.Mesh(GEO.thigh, shortsMat),
      // Socks take the shirt colour, as they do on nearly every kit.
      new THREE.Mesh(GEO.shin, shirtMat),
      new THREE.Mesh(GEO.shin, shirtMat),
      new THREE.Mesh(GEO.shadow, shadowMat),
    ];
    for (const part of parts) p.add(part);
    group.add(p);
  }
  return group;
};

/** Pose one figure for a position, heading and gait phase. */
const poseFigure = (
  figure: THREE.Object3D,
  x: number,
  z: number,
  heading: number,
  gait: number,
  speed: number,
) => {
  const c = figure.children as THREE.Mesh[];
  const limbs: Limbs = {
    torso: c[0]!, head: c[1]!, armL: c[2]!, armR: c[3]!,
    thighL: c[4]!, thighR: c[5]!, shinL: c[6]!, shinR: c[7]!, shadow: c[8]!,
  };
  if (!limbs.shadow) return;

  figure.position.set(x, 0, z);
  figure.rotation.y = heading;

  const amp = Math.min(1, speed * 0.6);
  const bob = Math.abs(Math.cos(gait)) * 0.014 * amp;
  const hipY = SEG.hip + bob;
  // A running figure leans into the run.
  const lean = amp * 0.14;

  const shoulderY = hipY + SEG.torso;
  scratchA.set(0, hipY, 0);
  scratchB.set(0, shoulderY, lean * 0.06);
  spanLimb(limbs.torso, scratchA, scratchB);

  limbs.head.position.set(0, shoulderY + 0.028, lean * 0.07);

  // Legs: hip → knee → foot, with a real knee bend that trails the thigh.
  for (const side of [-1, 1] as const) {
    const phase = side < 0 ? gait : gait + Math.PI;
    const thighAngle = Math.sin(phase) * 0.85 * amp;
    // The knee only bends one way, and bends most as the leg swings through.
    const kneeBend = Math.max(0, -Math.cos(phase)) * 1.15 * amp + 0.12;

    const hipX = side * 0.019;
    const hip = scratchA.set(hipX, hipY, 0);
    const knee = new THREE.Vector3(
      hipX,
      hipY - Math.cos(thighAngle) * SEG.thigh,
      Math.sin(thighAngle) * SEG.thigh,
    );
    const shinAngle = thighAngle - kneeBend;
    const foot = new THREE.Vector3(
      hipX,
      knee.y - Math.cos(shinAngle) * SEG.shin,
      knee.z + Math.sin(shinAngle) * SEG.shin,
    );

    spanLimb(side < 0 ? limbs.thighL : limbs.thighR, hip, knee);
    spanLimb(side < 0 ? limbs.shinL : limbs.shinR, knee, foot);

    // Arms counter-swing against the legs on the same side.
    const armAngle = -Math.sin(phase) * 0.8 * amp;
    const shoulder = new THREE.Vector3(side * 0.036, shoulderY - 0.012, 0);
    const hand = new THREE.Vector3(
      side * 0.044,
      shoulder.y - Math.cos(armAngle) * SEG.arm,
      Math.sin(armAngle) * SEG.arm,
    );
    spanLimb(side < 0 ? limbs.armL : limbs.armR, shoulder, hand);
  }

  limbs.shadow.position.set(0, 0.006, 0);
  limbs.shadow.rotation.set(-Math.PI / 2, 0, 0);
};

export const PitchAction: React.FC<{
  /** 0 → 1 across the move. */
  t: number;
  /** Seconds, for gait timing. */
  seconds: number;
  reveal: number;
  /**
   * Real kit colours, not a generic bone-vs-terracotta pair. Uruguay wear
   * solid sky blue; Argentina wear white with a sky-blue stripe — which,
   * conveniently, is also the colour pairing with the most contrast for a
   * shot that has to read at a glance.
   */
  homeKit?: string;
  awayKit?: string;
}> = ({t, seconds, reveal, homeKit = '#3E86C4', awayKit = '#F4EFE6'}) => {
  // Uruguay: sky-blue shirt, black shorts. Argentina: white shirt, black
  // shorts. Both real, and both readable against green from the air.
  const home = useMemo(() => buildTeam(11, homeKit, '#14203A', '#C99A72'), [homeKit]);
  const away = useMemo(() => buildTeam(11, awayKit, '#1A1A22', '#E7C9A8'), [awayKit]);

  const ball = ballAt(t);

  useMemo(() => {
    // Positioning runs inside useMemo keyed on t so it happens once per frame,
    // before Three renders, without a per-frame React tree walk.
    for (const [group, shape, isHome] of [
      [home, HOME_SHAPE, true],
      [away, AWAY_SHAPE, false],
    ] as const) {
      group.children.forEach((figure, i) => {
        const base = shape[i] ?? {x: 0, z: 0};
        const p = playerAt(base, i, t, isHome);
        const next = playerAt(base, i, Math.min(1, t + 0.008), isHome);
        const heading = Math.atan2(next.x - p.x, next.z - p.z) || (isHome ? Math.PI / 2 : -Math.PI / 2);
        // Gait phase advances with distance covered, not with wall-clock —
        // that is why a stationary player's legs stop instead of treadmilling.
        const gait = seconds * (2.2 + p.speed * 1.6) + i * 1.3;
        poseFigure(figure, p.x, p.z, heading, gait, p.speed);
        figure.visible = reveal > 0.02;
      });
    }
  }, [home, away, t, seconds, reveal]);

  return (
    <group>
      <primitive object={home} />
      <primitive object={away} />

      {/* The ball. */}
      <mesh position={[ball.x, ball.y, ball.z]}>
        <sphereGeometry args={[0.06, 14, 14]} />
        <meshBasicMaterial color={palette.bone} toneMapped={false} />
      </mesh>
      {/* Its shadow stays on the ground, which is what sells a lofted pass. */}
      <mesh position={[ball.x, 0.012, ball.z]} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[0.06 + ball.y * 0.05, 12]} />
        <meshBasicMaterial
          color="#000000"
          transparent
          opacity={0.34 * Math.max(0.2, 1 - ball.y)}
        />
      </mesh>
    </group>
  );
};

/** Goals, nets and corner flags — the furniture that makes a pitch a pitch. */
export const PitchFurniture: React.FC<{reveal: number}> = ({reveal}) => {
  const netMat = useMemo(
    () => new THREE.MeshBasicMaterial({color: palette.bone, transparent: true, opacity: 0.18, wireframe: true}),
    [],
  );

  return (
    <group>
      {[-1, 1].map((side) => (
        <group key={side} position={[side * (PITCH_X + 0.05), 0, 0]}>
          {/* Posts and bar. */}
          {[-0.9, 0.9].map((z) => (
            <mesh key={z} position={[0, 0.36, z]}>
              <boxGeometry args={[0.05, 0.72, 0.05]} />
              <meshBasicMaterial color={palette.bone} transparent opacity={reveal} toneMapped={false} />
            </mesh>
          ))}
          <mesh position={[0, 0.72, 0]}>
            <boxGeometry args={[0.05, 0.05, 1.85]} />
            <meshBasicMaterial color={palette.bone} transparent opacity={reveal} toneMapped={false} />
          </mesh>
          {/* Net. */}
          <mesh position={[side * 0.28, 0.36, 0]} material={netMat}>
            <boxGeometry args={[0.56, 0.72, 1.85, 5, 4, 10]} />
          </mesh>
        </group>
      ))}

      {/* Corner flags. */}
      {[-1, 1].map((sx) =>
        [-1, 1].map((sz) => (
          <group key={`${sx}-${sz}`} position={[sx * PITCH_X, 0, sz * PITCH_Z]}>
            <mesh position={[0, 0.14, 0]}>
              <boxGeometry args={[0.02, 0.28, 0.02]} />
              <meshBasicMaterial color={palette.bone} transparent opacity={reveal} />
            </mesh>
            <mesh position={[0.05, 0.24, 0]}>
              <boxGeometry args={[0.1, 0.07, 0.01]} />
              <meshBasicMaterial color={palette.goldTrophy} transparent opacity={reveal} toneMapped={false} />
            </mesh>
          </group>
        )),
      )}
    </group>
  );
};
