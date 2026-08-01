import {useMemo} from 'react';
import * as THREE from 'three';
import {palette} from '../config/theme';
import {CrowdWave} from '../components/CrowdWave';

/**
 * A modern stadium bowl at dusk: pitch, stands, and a roof ring that glows
 * gold.
 *
 * The bowl is an open cone rather than a closed cylinder so the camera can
 * descend through it in one unbroken move, from above the roof line down to
 * eye height on the halfway line.
 *
 * The roof ring deliberately carries the Torre de los Homenajes proportion of
 * the Estadio Centenario in its single mast — Shot 02 builds that ground in
 * 1930 and this is where the film answers it.
 */

const PITCH_HALF_X = 5.0;
const PITCH_HALF_Z = 3.2;

const Pitch: React.FC = () => {
  const lines = useMemo(() => {
    const pts: number[] = [];
    const y = 0.02;
    const push = (x1: number, z1: number, x2: number, z2: number) => {
      pts.push(x1, y, z1, x2, y, z2);
    };

    // Touchlines and goal lines.
    push(-PITCH_HALF_X, -PITCH_HALF_Z, PITCH_HALF_X, -PITCH_HALF_Z);
    push(-PITCH_HALF_X, PITCH_HALF_Z, PITCH_HALF_X, PITCH_HALF_Z);
    push(-PITCH_HALF_X, -PITCH_HALF_Z, -PITCH_HALF_X, PITCH_HALF_Z);
    push(PITCH_HALF_X, -PITCH_HALF_Z, PITCH_HALF_X, PITCH_HALF_Z);
    // Halfway line.
    push(0, -PITCH_HALF_Z, 0, PITCH_HALF_Z);
    // Penalty areas.
    for (const sign of [-1, 1]) {
      const x = sign * PITCH_HALF_X;
      const box = sign * (PITCH_HALF_X - 1.5);
      push(x, -1.9, box, -1.9);
      push(x, 1.9, box, 1.9);
      push(box, -1.9, box, 1.9);
    }
    // Centre circle.
    const R = 1.0;
    for (let i = 0; i < 64; i++) {
      const a1 = (i / 64) * Math.PI * 2;
      const a2 = ((i + 1) / 64) * Math.PI * 2;
      push(Math.cos(a1) * R, Math.sin(a1) * R, Math.cos(a2) * R, Math.sin(a2) * R);
    }

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pts), 3));
    return g;
  }, []);

  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[PITCH_HALF_X * 2.3, PITCH_HALF_Z * 2.5]} />
        <meshBasicMaterial color={palette.pitchDeep} />
      </mesh>
      {/* Mow stripes. */}
      {Array.from({length: 12}, (_, i) => (
        <mesh
          key={i}
          rotation={[-Math.PI / 2, 0, 0]}
          position={[-PITCH_HALF_X + (i + 0.5) * ((PITCH_HALF_X * 2) / 12), 0.005, 0]}
        >
          <planeGeometry args={[(PITCH_HALF_X * 2) / 12, PITCH_HALF_Z * 2]} />
          <meshBasicMaterial color={i % 2 ? '#0D2A1B' : '#0A1F14'} />
        </mesh>
      ))}
      <lineSegments geometry={lines}>
        <lineBasicMaterial color={palette.bone} transparent opacity={0.4} />
      </lineSegments>
    </group>
  );
};

const RoofRing: React.FC<{glow: number}> = ({glow}) => (
  <group position={[0, 4.9, 0]}>
    <mesh rotation={[-Math.PI / 2, 0, 0]}>
      <ringGeometry args={[9.3, 10.6, 96]} />
      <meshBasicMaterial
        color={palette.ink}
        side={THREE.DoubleSide}
        transparent
        opacity={0.96}
      />
    </mesh>
    {/* The gold light line under the roof — the only gold in the shot until
        the lockup, and the thing that reads first in a wide aerial. */}
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.06, 0]}>
      <ringGeometry args={[9.0, 9.34, 96]} />
      <meshBasicMaterial
        color={palette.goldTrophy}
        side={THREE.DoubleSide}
        transparent
        opacity={glow}
        toneMapped={false}
      />
    </mesh>
  </group>
);

const Floodlights: React.FC<{glow: number}> = ({glow}) => (
  <group>
    {Array.from({length: 8}, (_, i) => {
      const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
      return (
        <mesh key={i} position={[Math.cos(a) * 9.9, 5.4, Math.sin(a) * 9.9]}>
          <sphereGeometry args={[0.13, 8, 8]} />
          <meshBasicMaterial
            color={palette.goldLight}
            transparent
            opacity={glow}
            toneMapped={false}
          />
        </mesh>
      );
    })}
  </group>
);

export const Stadium: React.FC<{
  wavePhase: number;
  intensity: number;
  reveal: number;
  crowdCount?: number;
}> = ({wavePhase, intensity, reveal, crowdCount}) => {
  return (
    <group>
      <Pitch />

      {/* Bowl shell behind the crowd, so the stands read as solid structure. */}
      <mesh position={[0, 2.2, 0]}>
        <cylinderGeometry args={[10.2, 5.2, 4.6, 96, 1, true]} />
        <meshBasicMaterial color="#061109" side={THREE.BackSide} />
      </mesh>

      <CrowdWave
        wavePhase={wavePhase}
        intensity={intensity}
        reveal={reveal}
        {...(crowdCount ? {count: crowdCount} : {})}
      />

      <RoofRing glow={0.85 * reveal} />
      <Floodlights glow={0.9 * reveal} />
    </group>
  );
};

/** 22 players, stylised, holding shape on the pitch and drifting with play. */
export const PitchPlayers: React.FC<{t: number; reveal: number}> = ({t, reveal}) => {
  const formation = useMemo(() => {
    // 4-3-3 mirrored, in pitch coordinates.
    const shape: [number, number][] = [
      [-4.5, 0],
      [-3.4, -2.1], [-3.4, -0.7], [-3.4, 0.7], [-3.4, 2.1],
      [-1.8, -1.4], [-1.8, 0], [-1.8, 1.4],
      [-0.5, -2.0], [-0.5, 0], [-0.5, 2.0],
    ];
    return [
      ...shape.map(([x, z]) => ({x, z, home: true})),
      ...shape.map(([x, z]) => ({x: -x, z: -z, home: false})),
    ];
  }, []);

  return (
    <group>
      {formation.map((p, i) => {
        // Everyone drifts on their own small orbit — a still 22 reads as a
        // diagram, and this shot has to feel like a live match.
        const wob = Math.sin(t * 2 + i * 1.7) * 0.22;
        const wob2 = Math.cos(t * 1.6 + i * 2.3) * 0.18;
        return (
          <mesh key={i} position={[p.x + wob, 0.17, p.z + wob2]}>
            <capsuleGeometry args={[0.05, 0.2, 4, 8]} />
            <meshBasicMaterial
              color={p.home ? palette.bone : palette.terracotta}
              transparent
              opacity={0.9 * reveal}
              toneMapped={false}
            />
          </mesh>
        );
      })}
      {/* The ball. */}
      <mesh position={[Math.sin(t * 1.3) * 2.4, 0.08, Math.cos(t * 0.9) * 1.4]}>
        <sphereGeometry args={[0.07, 12, 12]} />
        <meshBasicMaterial color={palette.goldLight} toneMapped={false} />
      </mesh>
    </group>
  );
};
