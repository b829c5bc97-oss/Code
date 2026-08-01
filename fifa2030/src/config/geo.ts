/**
 * Coarse national boundary rings, stored as real [longitude, latitude] pairs
 * rather than hand-drawn SVG. Two reasons:
 *
 *  1. The same data drives both the flat country outlines (Shots 05–10) and
 *     the pins/arcs on the 3D globe (Shot 04), so they can never disagree.
 *  2. Projected shapes read as the actual countries instead of approximations.
 *
 * These are deliberately low-vertex (20–40 points) to match the film's
 * graphic language — this is a title sequence, not an atlas.
 */

export type LonLat = readonly [number, number];

export const boundaries: Record<string, readonly LonLat[]> = {
  morocco: [
    [-2.2, 35.1],
    [-1.8, 34.7],
    [-1.5, 33.5],
    [-1.6, 32.6],
    [-1.2, 32.1],
    [-1.0, 31.4],
    [-2.0, 30.5],
    [-3.6, 29.6],
    [-5.0, 29.3],
    [-6.5, 29.5],
    [-8.0, 28.8],
    [-8.7, 27.7],
    [-10.5, 28.6],
    [-11.4, 28.8],
    [-12.0, 29.3],
    [-9.8, 30.4],
    [-9.6, 31.4],
    [-8.5, 32.9],
    [-7.6, 33.6],
    [-6.8, 34.0],
    [-6.3, 35.2],
    [-5.4, 35.9],
    [-4.3, 35.2],
    [-3.0, 35.2],
  ],
  spain: [
    [-8.9, 43.3],
    [-7.0, 43.6],
    [-5.0, 43.6],
    [-3.0, 43.4],
    [-1.8, 43.4],
    [-0.7, 42.8],
    [0.7, 42.7],
    [1.7, 42.5],
    [3.2, 42.4],
    [2.2, 41.4],
    [0.9, 41.0],
    [0.0, 39.9],
    [-0.3, 39.4],
    [-0.6, 38.2],
    [-1.5, 37.5],
    [-2.5, 36.8],
    [-4.4, 36.7],
    [-5.4, 36.1],
    [-6.3, 36.6],
    [-7.4, 37.2],
    [-7.4, 37.5],
    [-7.3, 38.0],
    [-7.0, 38.5],
    [-7.1, 39.1],
    [-7.5, 39.6],
    [-7.0, 40.0],
    [-6.8, 40.4],
    [-6.9, 41.0],
    [-6.2, 41.6],
    [-6.6, 41.9],
    [-7.0, 41.9],
    [-8.2, 42.1],
    [-8.9, 41.9],
    [-8.8, 42.6],
    [-9.3, 42.9],
  ],
  portugal: [
    [-8.9, 41.9],
    [-8.2, 42.1],
    [-7.0, 41.9],
    [-6.6, 41.9],
    [-6.2, 41.6],
    [-6.9, 41.0],
    [-6.8, 40.4],
    [-7.0, 40.0],
    [-7.5, 39.6],
    [-7.1, 39.1],
    [-7.0, 38.5],
    [-7.3, 38.0],
    [-7.4, 37.5],
    [-7.4, 37.2],
    [-8.0, 37.0],
    [-8.9, 36.98],
    [-9.0, 37.4],
    [-8.8, 38.0],
    [-9.2, 38.4],
    [-9.5, 38.7],
    [-8.9, 39.4],
    [-8.8, 40.2],
    [-8.7, 41.0],
    [-8.8, 41.5],
  ],
  uruguay: [
    [-57.6, -30.2],
    [-56.0, -30.9],
    [-55.6, -30.9],
    [-54.5, -31.5],
    [-53.8, -32.0],
    [-53.1, -32.7],
    [-53.5, -33.7],
    [-53.5, -34.4],
    [-54.9, -34.9],
    [-55.9, -34.8],
    [-56.2, -34.9],
    [-57.2, -34.9],
    [-58.4, -34.0],
    [-58.1, -33.1],
    [-58.3, -32.5],
    [-58.1, -31.9],
    [-58.0, -31.0],
  ],
  argentina: [
    [-62.8, -22.2],
    [-60.0, -24.0],
    [-58.2, -24.9],
    [-57.6, -25.5],
    [-55.0, -26.0],
    [-53.6, -26.9],
    [-55.3, -28.0],
    [-56.8, -30.2],
    [-58.0, -32.0],
    [-58.4, -34.0],
    [-57.5, -38.0],
    [-62.0, -39.0],
    [-62.3, -40.9],
    [-64.5, -42.0],
    [-65.0, -43.5],
    [-65.7, -45.0],
    [-67.6, -46.0],
    [-67.7, -49.3],
    [-68.9, -50.6],
    [-68.6, -52.3],
    [-68.6, -54.9],
    [-70.0, -52.6],
    [-72.0, -51.5],
    [-72.3, -50.0],
    [-73.5, -49.5],
    [-73.0, -47.0],
    [-71.8, -45.0],
    [-71.5, -43.0],
    [-71.7, -41.0],
    [-70.5, -38.5],
    [-69.5, -36.0],
    [-70.4, -34.5],
    [-69.8, -32.5],
    [-68.5, -30.0],
    [-68.8, -27.0],
    [-67.2, -24.0],
    [-66.5, -22.1],
    [-64.5, -22.2],
  ],
  paraguay: [
    [-62.6, -22.2],
    [-61.8, -19.6],
    [-59.9, -19.3],
    [-58.2, -19.8],
    [-57.8, -20.7],
    [-57.9, -22.1],
    [-56.4, -22.3],
    [-55.6, -22.3],
    [-54.6, -23.9],
    [-54.3, -24.1],
    [-54.6, -25.6],
    [-54.8, -26.6],
    [-56.0, -27.3],
    [-57.6, -27.4],
    [-58.6, -27.3],
    [-58.2, -26.0],
    [-58.2, -24.9],
    [-60.0, -24.0],
  ],
};

/**
 * Project a lon/lat ring into an SVG path normalised to fit `size` × `size`,
 * preserving the country's true proportions (with a cos(lat) correction so
 * Argentina doesn't come out stretched).
 */
export const ringToPath = (ring: readonly LonLat[], size = 100): string => {
  const lats = ring.map((p) => p[1]);
  const midLat = (Math.min(...lats) + Math.max(...lats)) / 2;
  const kx = Math.cos((midLat * Math.PI) / 180);

  const pts = ring.map(([lon, lat]) => [lon * kx, -lat] as const);
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const span = Math.max(maxX - minX, maxY - minY) || 1;
  const scale = size / span;
  const offX = (size - (maxX - minX) * scale) / 2;
  const offY = (size - (maxY - minY) * scale) / 2;

  const d = pts
    .map(([x, y], i) => {
      const px = ((x - minX) * scale + offX).toFixed(2);
      const py = ((y - minY) * scale + offY).toFixed(2);
      return `${i === 0 ? 'M' : 'L'}${px},${py}`;
    })
    .join(' ');

  return `${d} Z`;
};

/** Convert lat/lon to a point on a unit sphere (Three.js Y-up convention). */
export const latLonToVec3 = (
  lat: number,
  lon: number,
  radius = 1,
): [number, number, number] => {
  const phi = ((90 - lat) * Math.PI) / 180;
  const theta = ((lon + 180) * Math.PI) / 180;
  return [
    -radius * Math.sin(phi) * Math.cos(theta),
    radius * Math.cos(phi),
    radius * Math.sin(phi) * Math.sin(theta),
  ];
};

/**
 * Points along the great circle between two lat/lon positions, lifted above
 * the surface so the arc reads as a flight path rather than a surface line.
 * Uses spherical linear interpolation — this is what makes a Lisbon→Montevideo
 * arc bow correctly across the Atlantic instead of cutting straight.
 */
export const greatCircle = (
  from: LonLat,
  to: LonLat,
  segments = 64,
  lift = 0.28,
): [number, number, number][] => {
  const a = latLonToVec3(from[1], from[0], 1);
  const b = latLonToVec3(to[1], to[0], 1);
  const dot = Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
  const omega = Math.acos(dot);
  const sinOmega = Math.sin(omega);

  return Array.from({length: segments + 1}, (_, i) => {
    const t = i / segments;
    const [w1, w2] =
      sinOmega < 1e-6
        ? [1 - t, t]
        : [Math.sin((1 - t) * omega) / sinOmega, Math.sin(t * omega) / sinOmega];
    const x = a[0] * w1 + b[0] * w2;
    const y = a[1] * w1 + b[1] * w2;
    const z = a[2] * w1 + b[2] * w2;
    const len = Math.hypot(x, y, z) || 1;
    // Parabolic lift, peaking at the midpoint and proportional to distance.
    const r = 1 + Math.sin(t * Math.PI) * lift * (omega / Math.PI) * 2.2;
    return [(x / len) * r, (y / len) * r, (z / len) * r];
  });
};
