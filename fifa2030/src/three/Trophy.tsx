import {useMemo} from 'react';
import * as THREE from 'three';
import {palette} from '../config/theme';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE CENTENARY TROPHY
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A gold cup holding a wireframe globe, lathed from a profile curve so the
 * silhouette is a real surface of revolution rather than stacked primitives —
 * that is what lets the highlight travel around it convincingly as it turns.
 *
 * This is a GENERIC trophy form, not a replica of FIFA's actual World Cup
 * Trophy, whose sculpture is protected. Same approach as the brand marks
 * everywhere else in this build: drop the licensed model or render into
 * `public/brand/` and swap it in here.
 *
 * Gold is the hardest material to fake without an environment map. The trick
 * used here is a strong specular with high shininess plus a low emissive
 * floor, so the metal keeps a warm glow in shadow instead of going black the
 * way raw metalness does when there is nothing around to reflect.
 */

const goldMaterial = (emissiveBoost = 1) =>
  new THREE.MeshPhongMaterial({
    color: new THREE.Color(palette.goldTrophy),
    specular: new THREE.Color('#FFF6DC'),
    shininess: 110,
    emissive: new THREE.Color('#4A3410'),
    emissiveIntensity: 0.55 * emissiveBoost,
  });

/** Outer profile of the cup, bottom to rim and back down the inside. */
const CUP_PROFILE: [number, number][] = [
  [0.002, 0],
  [0.52, 0],
  [0.52, 0.09],
  [0.43, 0.14],
  [0.22, 0.2],
  [0.14, 0.4],
  [0.135, 0.58],
  [0.2, 0.68],
  [0.33, 0.84],
  [0.43, 1.04],
  [0.47, 1.26],
  [0.475, 1.34],
  // Back down the inside — this is what makes it a cup and not a cone.
  [0.4, 1.3],
  [0.37, 1.1],
  [0.28, 0.92],
  [0.16, 0.8],
  [0.002, 0.76],
];

export const Trophy: React.FC<{
  /** Radians. */
  spin?: number;
  scale?: number;
  position?: [number, number, number];
}> = ({spin = 0, scale = 1, position = [0, 0, 0]}) => {
  const cup = useMemo(() => {
    const pts = CUP_PROFILE.map(([x, y]) => new THREE.Vector2(x, y));
    const geo = new THREE.LatheGeometry(pts, 48);
    return new THREE.Mesh(geo, goldMaterial());
  }, []);

  const globe = useMemo(() => {
    const g = new THREE.Group();
    const sphere = new THREE.Mesh(
      new THREE.SphereGeometry(0.26, 26, 20),
      goldMaterial(1.35),
    );
    sphere.position.y = 1.5;
    g.add(sphere);
    // Meridians, so it reads as a globe rather than a ball bearing.
    const wire = new THREE.Mesh(
      new THREE.SphereGeometry(0.268, 16, 12),
      new THREE.MeshBasicMaterial({
        color: new THREE.Color(palette.goldLight),
        wireframe: true,
        transparent: true,
        opacity: 0.45,
      }),
    );
    wire.position.y = 1.5;
    g.add(wire);
    return g;
  }, []);

  /** The engraved band around the cup — where a real trophy carries names. */
  const band = useMemo(() => {
    const m = new THREE.Mesh(
      new THREE.TorusGeometry(0.44, 0.022, 8, 48),
      goldMaterial(1.6),
    );
    m.rotation.x = Math.PI / 2;
    m.position.y = 1.16;
    return m;
  }, []);

  return (
    <group position={position} rotation={[0, spin, 0]} scale={[scale, scale, scale]}>
      <primitive object={cup} />
      <primitive object={band} />
      <primitive object={globe} />
    </group>
  );
};

/**
 * The lift itself: a knot of players around one figure with the trophy raised
 * overhead.
 *
 * Deliberately a CLUSTER, not a neat row. A trophy lift is a scrum — bodies
 * pressed in at every angle, arms up, nobody where a formation would put
 * them. Spacing them evenly would read as a team photo, which is the opposite
 * of the moment.
 */
export const TrophyLift: React.FC<{
  /** 0 → 1 through the celebration. */
  t: number;
  /** Seconds, for the bounce. */
  seconds: number;
  kit: string;
  shorts?: string;
  skin?: string;
}> = ({t, seconds, kit, shorts = '#14203A', skin = '#C99A72'}) => {
  const group = useMemo(() => {
    const g = new THREE.Group();
    const shirt = new THREE.MeshPhongMaterial({
      color: new THREE.Color(kit),
      shininess: 20,
      specular: new THREE.Color('#2A2A2A'),
    });
    const shortsMat = new THREE.MeshPhongMaterial({
      color: new THREE.Color(shorts),
      shininess: 14,
    });
    const flesh = new THREE.MeshPhongMaterial({color: new THREE.Color(skin), shininess: 8});

    // Built at EXACTLY the same scale as the pitch players (≈0.26 tall). They
    // share a frame with the rest of the team, and a celebration group at its
    // own scale reads as a compositing error, not as a crowd.
    const torsoGeo = new THREE.CapsuleGeometry(0.032, 0.062, 4, 10);
    const headGeo = new THREE.SphereGeometry(0.026, 12, 10);
    // Longer than a pitch-player's arm, because these are fully extended.
    const armGeo = new THREE.CapsuleGeometry(0.0115, 0.075, 3, 8);
    const legGeo = new THREE.CapsuleGeometry(0.0165, 0.055, 3, 8);

    // A scrum, not a row: bodies at every depth, nobody on a grid.
    const layout: [number, number][] = [
      [0, 0.06],
      [-0.13, -0.02], [0.14, 0.0], [-0.26, 0.1], [0.27, 0.08],
      [-0.09, -0.16], [0.1, -0.18], [-0.38, -0.04], [0.39, -0.06],
      [-0.2, 0.22], [0.22, 0.2],
    ];

    layout.forEach(([x, z], i) => {
      const p = new THREE.Group();
      p.position.set(x, 0, z);
      p.rotation.y = (i * 0.7) % 1.2 - 0.6;

      const torso = new THREE.Mesh(torsoGeo, shirt);
      torso.position.y = 0.145;
      p.add(torso);

      const head = new THREE.Mesh(headGeo, flesh);
      head.position.y = 0.2;
      p.add(head);

      for (const side of [-1, 1]) {
        /**
         * Arms fully overhead. They were centred at head height, which put the
         * hands level with the ears — the figures read as shrugging rather
         * than celebrating. The arm now spans clearly above the crown.
         */
        const arm = new THREE.Mesh(armGeo, flesh);
        arm.position.set(side * 0.036, 0.255, 0);
        arm.rotation.z = side * -0.19;
        p.add(arm);

        const leg = new THREE.Mesh(legGeo, shortsMat);
        leg.position.set(side * 0.017, 0.055, 0);
        p.add(leg);
      }
      g.add(p);
    });
    return g;
  }, [kit, shorts, skin]);

  useMemo(() => {
    group.children.forEach((p, i) => {
      const bounce = Math.abs(Math.sin(seconds * 4.4 + i * 1.7)) * 0.022 * Math.min(1, t * 3);
      p.position.y = bounce;
    });
  }, [group, seconds, t]);

  // The trophy rises out of the scrum into the raised hands of the lifter.
  const lift = Math.min(1, Math.max(0, (t - 0.12) / 0.5));
  const eased = 1 - Math.pow(1 - lift, 2.4);
  const trophyY = 0.2 + eased * 0.13 + Math.sin(seconds * 3.1) * 0.006;

  return (
    <group>
      <primitive object={group} />
      <Trophy
        position={[0, trophyY, 0.06]}
        // Trophy geometry is ~1.55 units tall, so this lands it at ≈0.1 —
        // about a third of a player's height, which is life-size for a cup.
        scale={0.075}
        spin={seconds * 0.5}
      />
    </group>
  );
};
