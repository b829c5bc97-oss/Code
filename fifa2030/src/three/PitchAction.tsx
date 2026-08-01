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
 * One articulated figure: torso, head, two arms, two legs, each limb a scaled
 * box, plus a contact shadow. Built as raw THREE objects and posed by direct
 * transform writes — 22 figures × 9 parts is 198 meshes, and reconciling that
 * through React on every frame is the difference between a shot that renders
 * and one that crawls.
 */
const buildTeam = (count: number, kit: string, skin: string): THREE.Group => {
  const group = new THREE.Group();
  const body = new THREE.BoxGeometry(1, 1, 1);
  const kitMat = new THREE.MeshBasicMaterial({color: kit, toneMapped: false});
  const skinMat = new THREE.MeshBasicMaterial({color: skin, toneMapped: false});

  for (let i = 0; i < count; i++) {
    const p = new THREE.Group();
    // torso, head, armL, armR, thighL, shinL, thighR, shinR, shadow
    const parts = [
      new THREE.Mesh(body, kitMat),
      new THREE.Mesh(body, skinMat),
      new THREE.Mesh(body, skinMat),
      new THREE.Mesh(body, skinMat),
      new THREE.Mesh(body, kitMat),
      new THREE.Mesh(body, skinMat),
      new THREE.Mesh(body, kitMat),
      new THREE.Mesh(body, skinMat),
      new THREE.Mesh(body, new THREE.MeshBasicMaterial({color: '#000000', transparent: true, opacity: 0.3})),
    ];
    for (const part of parts) p.add(part);
    group.add(p);
  }
  return group;
};

/** Pose a single figure's parts for a given position, heading and gait phase. */
const poseFigure = (
  figure: THREE.Object3D,
  x: number,
  z: number,
  heading: number,
  gait: number,
  speed: number,
  scale: number,
) => {
  const [torso, head, armL, armR, thighL, shinL, thighR, shinR, shadow] =
    figure.children as THREE.Mesh[];
  if (!torso || !head || !armL || !armR || !thighL || !shinL || !thighR || !shinR || !shadow) return;

  figure.position.set(x, 0, z);
  figure.rotation.y = heading;

  // Stride amplitude scales with speed — a jogging player barely swings.
  const amp = Math.min(1, speed * 0.55);
  const swing = Math.sin(gait) * amp;
  const swing2 = Math.sin(gait + Math.PI) * amp;
  // The body rises and falls once per stride.
  const bob = Math.abs(Math.cos(gait)) * 0.03 * amp;

  const S = scale;
  torso.position.set(0, (0.42 + bob) * S, 0);
  torso.scale.set(0.17 * S, 0.3 * S, 0.1 * S);

  head.position.set(0, (0.63 + bob) * S, 0);
  head.scale.set(0.12 * S, 0.13 * S, 0.12 * S);

  armL.position.set(-0.13 * S, (0.44 + bob) * S, swing2 * 0.1 * S);
  armL.scale.set(0.06 * S, 0.24 * S, 0.06 * S);
  armL.rotation.x = swing2 * 0.7;

  armR.position.set(0.13 * S, (0.44 + bob) * S, swing * 0.1 * S);
  armR.scale.set(0.06 * S, 0.24 * S, 0.06 * S);
  armR.rotation.x = swing * 0.7;

  thighL.position.set(-0.07 * S, (0.22 + bob) * S, swing * 0.09 * S);
  thighL.scale.set(0.08 * S, 0.2 * S, 0.08 * S);
  thighL.rotation.x = swing * 0.8;

  shinL.position.set(-0.07 * S, (0.07 + bob) * S, swing * 0.16 * S);
  shinL.scale.set(0.065 * S, 0.16 * S, 0.065 * S);
  shinL.rotation.x = swing * 0.4;

  thighR.position.set(0.07 * S, (0.22 + bob) * S, swing2 * 0.09 * S);
  thighR.scale.set(0.08 * S, 0.2 * S, 0.08 * S);
  thighR.rotation.x = swing2 * 0.8;

  shinR.position.set(0.07 * S, (0.07 + bob) * S, swing2 * 0.16 * S);
  shinR.scale.set(0.065 * S, 0.16 * S, 0.065 * S);
  shinR.rotation.x = swing2 * 0.4;

  // Contact shadow, so nobody floats.
  shadow.position.set(0, 0.008, 0);
  shadow.scale.set(0.26 * S, 0.001, 0.18 * S);
  shadow.rotation.set(0, 0, 0);
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
  const home = useMemo(() => buildTeam(11, homeKit, '#C99A72'), [homeKit]);
  const away = useMemo(() => buildTeam(11, awayKit, '#E7C9A8'), [awayKit]);

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
        poseFigure(figure, p.x, p.z, heading, gait, p.speed, 0.34);
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
