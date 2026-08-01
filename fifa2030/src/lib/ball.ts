/**
 * A real truncated icosahedron — 12 pentagons, 20 hexagons — built from an
 * icosahedron and projected to the sphere.
 *
 * The ball in Shot 12 is not a flat illustration of a football: it is the
 * actual solid, so it can rotate through a full turn with correct panel
 * foreshortening and back-face culling. The same face list also gives us six
 * genuine panels for the six host nations to assemble into.
 */

export type Vec3 = readonly [number, number, number];

const PHI = (1 + Math.sqrt(5)) / 2;

const ICO_VERTS: Vec3[] = [
  [-1, PHI, 0],
  [1, PHI, 0],
  [-1, -PHI, 0],
  [1, -PHI, 0],
  [0, -1, PHI],
  [0, 1, PHI],
  [0, -1, -PHI],
  [0, 1, -PHI],
  [PHI, 0, -1],
  [PHI, 0, 1],
  [-PHI, 0, -1],
  [-PHI, 0, 1],
];

const ICO_FACES: [number, number, number][] = [
  [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
  [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
  [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
  [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
];

const normalize = (v: Vec3): Vec3 => {
  const len = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / len, v[1] / len, v[2] / len];
};

const lerp3 = (a: Vec3, b: Vec3, t: number): Vec3 => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

const centroidOf = (pts: Vec3[]): Vec3 => {
  const s = pts.reduce<[number, number, number]>(
    (acc, p) => [acc[0] + p[0], acc[1] + p[1], acc[2] + p[2]],
    [0, 0, 0],
  );
  return [s[0] / pts.length, s[1] / pts.length, s[2] / pts.length];
};

export type Panel = {
  index: number;
  kind: 'pentagon' | 'hexagon';
  /** Unit-sphere vertices, wound consistently. */
  vertices: Vec3[];
  /** Outward unit normal / centroid direction. */
  normal: Vec3;
};

const key = (v: Vec3) => v.map((n) => n.toFixed(4)).join(',');

const buildPanels = (): Panel[] => {
  // Neighbour map from the icosahedron's edges.
  const neighbours = new Map<number, Set<number>>();
  for (const [a, b, c] of ICO_FACES) {
    for (const [u, v] of [
      [a, b],
      [b, c],
      [c, a],
    ] as const) {
      if (!neighbours.has(u)) neighbours.set(u, new Set());
      if (!neighbours.has(v)) neighbours.set(v, new Set());
      neighbours.get(u)!.add(v);
      neighbours.get(v)!.add(u);
    }
  }

  const cut = (from: number, to: number, t: number): Vec3 =>
    normalize(lerp3(ICO_VERTS[from]!, ICO_VERTS[to]!, t));

  const panels: Panel[] = [];

  // Each icosahedron face truncates into a hexagon.
  for (const [a, b, c] of ICO_FACES) {
    const vertices = [
      cut(a, b, 1 / 3),
      cut(a, b, 2 / 3),
      cut(b, c, 1 / 3),
      cut(b, c, 2 / 3),
      cut(c, a, 1 / 3),
      cut(c, a, 2 / 3),
    ];
    panels.push({
      index: panels.length,
      kind: 'hexagon',
      vertices,
      normal: normalize(centroidOf(vertices)),
    });
  }

  // Each icosahedron vertex truncates into a pentagon.
  for (let v = 0; v < ICO_VERTS.length; v++) {
    const axis = normalize(ICO_VERTS[v]!);
    const ring = [...(neighbours.get(v) ?? [])].map((n) => cut(v, n, 1 / 3));

    // Order the five points around the vertex axis so the polygon is convex.
    const ref = normalize([
      ring[0]![0] - axis[0] * dot(ring[0]!, axis),
      ring[0]![1] - axis[1] * dot(ring[0]!, axis),
      ring[0]![2] - axis[2] * dot(ring[0]!, axis),
    ]);
    const bi = cross(axis, ref);
    const sorted = ring
      .map((p) => {
        const proj: Vec3 = [
          p[0] - axis[0] * dot(p, axis),
          p[1] - axis[1] * dot(p, axis),
          p[2] - axis[2] * dot(p, axis),
        ];
        return {p, angle: Math.atan2(dot(proj, bi), dot(proj, ref))};
      })
      .sort((x, y) => x.angle - y.angle)
      .map((x) => x.p);

    panels.push({index: panels.length, kind: 'pentagon', vertices: sorted, normal: axis});
  }

  return panels;
};

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

export const PANELS: Panel[] = buildPanels();

/** Rotate a point by yaw (around Y) then pitch (around X). Radians. */
export const rotate = (v: Vec3, yaw: number, pitch: number): Vec3 => {
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const x1 = v[0] * cy + v[2] * sy;
  const z1 = -v[0] * sy + v[2] * cy;
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  const y2 = v[1] * cp - z1 * sp;
  const z2 = v[1] * sp + z1 * cp;
  return [x1, y2, z2];
};

/**
 * Project a rotated unit-sphere point into the ball's 2D drawing space, where
 * the ball has radius `radius` and the origin is at the centre. A mild
 * perspective divide keeps the panels from looking like a flat mosaic.
 */
export const project = (v: Vec3, radius: number, perspective = 4.2): [number, number] => {
  const scale = perspective / (perspective - v[2]);
  return [v[0] * radius * scale, -v[1] * radius * scale];
};

export const panelPath = (
  panel: Panel,
  yaw: number,
  pitch: number,
  radius: number,
): {d: string; facing: number; centroid: [number, number]} => {
  const rotated = panel.vertices.map((v) => rotate(v, yaw, pitch));
  const pts = rotated.map((v) => project(v, radius));
  const n = rotate(panel.normal, yaw, pitch);
  const d =
    pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0].toFixed(2)},${p[1].toFixed(2)}`).join(' ') + ' Z';
  const c = project(n, radius);
  return {d, facing: n[2], centroid: c};
};

/** Two panels are adjacent when they share an edge (two vertices). */
const sharesEdge = (a: Panel, b: Panel): boolean => {
  const keys = new Set(a.vertices.map(key));
  let shared = 0;
  for (const v of b.vertices) if (keys.has(key(v))) shared++;
  return shared >= 2;
};

/**
 * The six panels the host nations assemble into: the front-facing pentagon and
 * the five hexagons that ring it — the classic football "flower".
 *
 * The centre pentagon is reserved for Uruguay. The tournament opens at the
 * Estadio Centenario, so the ball is built outward from where it began.
 */
export const hostPanels = (yaw: number, pitch: number): Panel[] => {
  const pentagons = PANELS.filter((p) => p.kind === 'pentagon');
  const frontMost = pentagons.reduce((best, p) =>
    rotate(p.normal, yaw, pitch)[2] > rotate(best.normal, yaw, pitch)[2] ? p : best,
  );
  const ring = PANELS.filter((p) => p.kind === 'hexagon' && sharesEdge(frontMost, p));

  // Order the ring clockwise on screen so nations assemble in a readable
  // rotation rather than jumping around the ball.
  const centre = project(rotate(frontMost.normal, yaw, pitch), 1);
  const ordered = ring
    .map((p) => {
      const c = project(rotate(p.normal, yaw, pitch), 1);
      return {p, angle: Math.atan2(c[1] - centre[1], c[0] - centre[0])};
    })
    .sort((a, b) => a.angle - b.angle)
    .map((x) => x.p);

  return [frontMost, ...ordered];
};

/**
 * Rotation at which the ball assembles, chosen so the host "flower" — the
 * pentagon plus its five hexagons — sits square to camera. A small yaw keeps
 * it from reading as a flat symmetrical badge.
 */
export const ASSEMBLY_YAW = 0.11;
export const ASSEMBLY_PITCH = 0.5536;
