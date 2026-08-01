import {useLayoutEffect, useMemo, useRef} from 'react';
import * as THREE from 'three';
import {nations} from '../config/nations';

/**
 * The crowd: an instanced particle field of tens of thousands of points
 * wrapped around the stadium bowl, doing a Mexican wave.
 *
 * Two things matter here beyond the count.
 *
 * 1. Colour is sampled from all six national palettes and shuffled through the
 *    whole bowl — NOT segregated into blocks by section. That is the shot's
 *    entire argument, expressed in the data: one crowd, not six.
 *
 * 2. Every instance carries a random phase offset, so the wave has soft edges
 *    and individual spectators stand fractionally early or late, the way a real
 *    one does. A wave with no phase jitter reads as a rotating stripe.
 */

export type CrowdProps = {
  /** Radians travelled by the wavefront. */
  wavePhase: number;
  /** 0 → 1, drives how far people rise. Wire this to audio amplitude. */
  intensity: number;
  count?: number;
  innerRadius?: number;
  outerRadius?: number;
  bowlHeight?: number;
  /** 0 → 1 reveal of the crowd. */
  reveal: number;
};

const dummy = new THREE.Object3D();
const colorScratch = new THREE.Color();

export const CrowdWave: React.FC<CrowdProps> = ({
  wavePhase,
  intensity,
  count = 26000,
  innerRadius = 5.4,
  outerRadius = 9.6,
  bowlHeight = 4.4,
  reveal,
}) => {
  const meshRef = useRef<THREE.InstancedMesh>(null);

  /**
   * Seats are laid out once. A deterministic hash rather than Math.random keeps
   * the crowd identical on every frame of every render pass — a crowd that
   * reshuffles per frame would strobe.
   */
  const seats = useMemo(() => {
    const hash = (n: number) => {
      const x = Math.sin(n * 127.1) * 43758.5453;
      return x - Math.floor(x);
    };

    const palette = nations.flatMap((n) => [n.colors.field, n.colors.secondary, n.colors.line]);

    const out = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const phases = new Float32Array(count);
    const angles = new Float32Array(count);

    for (let i = 0; i < count; i++) {
      const angle = hash(i * 3.1) * Math.PI * 2;
      // Tiers: sqrt keeps seat density even across the bowl's area rather than
      // bunching everyone against the inner rail.
      const tier = Math.sqrt(hash(i * 7.7));
      const radius = innerRadius + tier * (outerRadius - innerRadius);
      const y = tier * bowlHeight;

      out[i * 3] = Math.cos(angle) * radius;
      out[i * 3 + 1] = y;
      out[i * 3 + 2] = Math.sin(angle) * radius;

      // Colours are drawn from all six nations and scattered, never blocked.
      const c = palette[Math.floor(hash(i * 11.3) * palette.length)] ?? '#F4EFE6';
      colorScratch.set(c);
      colors[i * 3] = colorScratch.r;
      colors[i * 3 + 1] = colorScratch.g;
      colors[i * 3 + 2] = colorScratch.b;

      phases[i] = hash(i * 17.9);
      angles[i] = angle;
    }
    return {positions: out, colors, phases, angles};
  }, [count, innerRadius, outerRadius, bowlHeight]);

  useLayoutEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;

    const WAVE_WIDTH = 0.85; // radians of bowl the wavefront spans

    for (let i = 0; i < count; i++) {
      const angle = seats.angles[i]!;
      // Angular distance from the wavefront, wrapped to [-π, π].
      let d = angle - wavePhase;
      d = ((d % (Math.PI * 2)) + Math.PI * 3) % (Math.PI * 2) - Math.PI;

      // Raised cosine window: a smooth stand-and-sit, not a hard edge.
      const inWave = Math.abs(d) < WAVE_WIDTH;
      const w = inWave ? (Math.cos((d / WAVE_WIDTH) * Math.PI) + 1) / 2 : 0;
      // Phase jitter — this is what makes it look like people rather than a bar.
      const jittered = Math.max(0, w - seats.phases[i]! * 0.32);

      const lift = jittered * 0.42 * intensity;

      dummy.position.set(
        seats.positions[i * 3]!,
        seats.positions[i * 3 + 1]! + lift,
        seats.positions[i * 3 + 2]!,
      );
      const s = (0.045 + jittered * 0.05) * reveal;
      dummy.scale.set(s, s * 1.7, s);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);

      // Standing spectators brighten — the wave carries light around the bowl.
      const boost = 0.55 + jittered * 0.9;
      mesh.setColorAt(
        i,
        colorScratch.setRGB(
          seats.colors[i * 3]! * boost,
          seats.colors[i * 3 + 1]! * boost,
          seats.colors[i * 3 + 2]! * boost,
        ),
      );
    }

    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [seats, wavePhase, intensity, count, reveal]);

  return (
    <instancedMesh ref={meshRef} args={[undefined, undefined, count]} frustumCulled={false}>
      <boxGeometry args={[1, 1, 1]} />
      <meshBasicMaterial toneMapped={false} />
    </instancedMesh>
  );
};
