import {useMemo} from 'react';
import * as THREE from 'three';
import {boundaries, latLonToVec3, type LonLat} from '../config/geo';
import {palette} from '../config/theme';

/**
 * The globe: a solid sphere under a wireframe shell, with the six host
 * nations' real coastlines traced onto the surface.
 *
 * Geometry only. The pins, the great-circle arcs and the labels are drawn in
 * an SVG overlay above this canvas (see `scenes/04-Globe.tsx`) so the arcs can
 * animate with a genuine stroke-dashoffset, which is the look the brief calls
 * for and which line primitives in WebGL cannot give without a custom shader.
 */

export const GLOBE_RADIUS = 1;

/** Camera setup shared with the SVG overlay so the two layers stay registered. */
export const GLOBE_CAMERA = {
  distance: 4.5,
  /** Globe sits above centre so the lower third stays clear for the title. */
  offsetY: 0.3,
  fov: 42,
} as const;

const ringToPositions = (ring: readonly LonLat[], radius: number): Float32Array => {
  const pts: number[] = [];
  const closed = [...ring, ring[0]!];
  for (let i = 0; i < closed.length - 1; i++) {
    const a = closed[i]!;
    const b = closed[i + 1]!;
    // Subdivide each edge so it hugs the sphere instead of cutting through it.
    const steps = 6;
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      const lon = a[0] + (b[0] - a[0]) * t;
      const lat = a[1] + (b[1] - a[1]) * t;
      pts.push(...latLonToVec3(lat, lon, radius));
    }
  }
  pts.push(...latLonToVec3(ring[0]![1], ring[0]![0], radius));
  return new Float32Array(pts);
};

const Graticule: React.FC<{radius: number; color: string; opacity: number}> = ({
  radius,
  color,
  opacity,
}) => {
  const geometry = useMemo(() => {
    const pts: number[] = [];
    // Parallels every 20°, meridians every 20°.
    for (let lat = -60; lat <= 60; lat += 20) {
      for (let lon = -180; lon < 180; lon += 4) {
        pts.push(...latLonToVec3(lat, lon, radius));
        pts.push(...latLonToVec3(lat, lon + 4, radius));
      }
    }
    for (let lon = -180; lon < 180; lon += 20) {
      for (let lat = -88; lat < 88; lat += 4) {
        pts.push(...latLonToVec3(lat, lon, radius));
        pts.push(...latLonToVec3(lat + 4, lon, radius));
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pts), 3));
    return g;
  }, [radius]);

  return (
    <lineSegments geometry={geometry}>
      <lineBasicMaterial color={color} transparent opacity={opacity} />
    </lineSegments>
  );
};

const Coastline: React.FC<{
  ring: readonly LonLat[];
  radius: number;
  color: string;
  opacity: number;
}> = ({ring, radius, color, opacity}) => {
  // Built as a plain THREE.Line and mounted via <primitive>: R3F's intrinsic
  // <line> collides with the SVG line element in JSX's type space.
  const object = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(ringToPositions(ring, radius), 3));
    return new THREE.Line(g, new THREE.LineBasicMaterial({color, transparent: true, opacity}));
  }, [ring, radius, color, opacity]);

  return <primitive object={object} />;
};

export const Globe: React.FC<{
  /** Radians. */
  rotation: number;
  tilt?: number;
  /** 0 → 1, fades the whole globe up. */
  reveal: number;
}> = ({rotation, tilt = 0.32, reveal}) => {
  return (
    <group position={[0, GLOBE_CAMERA.offsetY, 0]} rotation={[tilt, rotation, 0]}>
      {/* Solid body. */}
      <mesh>
        <sphereGeometry args={[GLOBE_RADIUS * 0.995, 64, 48]} />
        <meshBasicMaterial color={palette.pitchDeep} transparent opacity={0.92 * reveal} />
      </mesh>

      {/* Wireframe shell over the solid — the brief's globe look. */}
      <mesh>
        <sphereGeometry args={[GLOBE_RADIUS * 1.002, 36, 24]} />
        <meshBasicMaterial
          color={palette.atlantic}
          wireframe
          transparent
          opacity={0.34 * reveal}
        />
      </mesh>

      <Graticule radius={GLOBE_RADIUS * 1.004} color={palette.atlantic} opacity={0.3 * reveal} />

      {/* The six host nations traced on the surface. */}
      {Object.entries(boundaries).map(([id, ring]) => (
        <Coastline
          key={id}
          ring={ring}
          radius={GLOBE_RADIUS * 1.008}
          color={palette.bone}
          opacity={0.85 * reveal}
        />
      ))}
    </group>
  );
};

/**
 * Project a point on the (already rotated) globe into overlay pixel space,
 * replicating the Three.js perspective camera exactly so pins and arcs land on
 * the geometry beneath them.
 */
export const projectToScreen = (
  p: readonly [number, number, number],
  width: number,
  height: number,
): {x: number; y: number; visible: boolean; depth: number} => {
  const {distance, fov, offsetY} = GLOBE_CAMERA;
  const depth = distance - p[2];
  const tanHalf = Math.tan((fov * Math.PI) / 360);
  const aspect = width / height;
  const xNdc = p[0] / (depth * tanHalf * aspect);
  const yNdc = (p[1] + offsetY) / (depth * tanHalf);
  return {
    x: (xNdc * 0.5 + 0.5) * width,
    y: (0.5 - yNdc * 0.5) * height,
    // A surface point on a unit sphere is on the near side when z > 1/distance.
    visible: p[2] > GLOBE_RADIUS / distance,
    depth,
  };
};

/** Apply the globe's tilt and spin to a point, matching the `<group>` above. */
export const applyGlobeRotation = (
  p: readonly [number, number, number],
  rotation: number,
  tilt = 0.32,
): [number, number, number] => {
  // Three applies group rotation in XYZ order: X (tilt) then Y (spin).
  const cy = Math.cos(rotation);
  const sy = Math.sin(rotation);
  const x1 = p[0] * cy + p[2] * sy;
  const z1 = -p[0] * sy + p[2] * cy;
  const cx = Math.cos(tilt);
  const sx = Math.sin(tilt);
  return [x1, p[1] * cx - z1 * sx, p[1] * sx + z1 * cx];
};
