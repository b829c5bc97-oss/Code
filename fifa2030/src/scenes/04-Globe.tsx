import {useMemo} from 'react';
import {ThreeCanvas} from '@remotion/three';
import {AbsoluteFill, Easing, interpolate, spring, useCurrentFrame, useVideoConfig} from 'remotion';
import {useLayout} from '../config/layout';
import {greatCircle, latLonToVec3} from '../config/geo';
import {arcSequence, nationById, nations} from '../config/nations';
import {fontStacks, letterspacing, palette, springs, typeScale} from '../config/theme';
import {applyGlobeRotation, Globe, GLOBE_CAMERA, projectToScreen} from '../three/Globe';
import {TypeLine} from '../components/TypeLockup';

/**
 * SHOT 04 — THE GLOBE / THREE CONTINENTS (0:28 – 0:36 | frames 840–1080)
 *
 *   frames  0– 30  globe fades up, already turning
 *   frames 24–120  six pins light in sequence: Africa, Iberia, then across
 *                  the Atlantic to South America
 *   frames 40–170  five great-circle arcs draw between them
 *   frames 96–190  "THREE CONTINENTS. SIX NATIONS. ONE TOURNAMENT."
 *   frames 200–240 camera dives into the Morocco pin
 *
 * The pin order is the film's argument in miniature: the tournament proper in
 * Africa and Iberia, then the crossing back to where it began.
 */

const PIN_START = 24;
const PIN_STRIDE = 15; // one beat each
const ARC_START = 46;
const ARC_STRIDE = 15;
const ARC_DRAW = 34;
const DIVE_START = 200;

/**
 * Pins light in host order; the Atlantic crossing is the fourth beat.
 *
 * Madrid, Lisbon and Casablanca sit within a few degrees of each other at globe
 * scale, so each pin carries its own leader direction — without that the three
 * Iberian/North African labels stack on top of one another.
 */
const PIN_ORDER: {id: string; leader: [number, number]}[] = [
  {id: 'morocco', leader: [1, 1]},
  {id: 'spain', leader: [1, -1]},
  {id: 'portugal', leader: [-1, -1.9]},
  {id: 'uruguay', leader: [1, 1.2]},
  {id: 'argentina', leader: [-1, 1.5]},
  {id: 'paraguay', leader: [1, -2.6]},
];

export const GlobeScene: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const {u, t, width, height, pick} = useLayout();

  /**
   * Constant slow drift — the camera never sits still.
   *
   * The range is chosen so the Atlantic faces camera for the whole shot: every
   * one of the six hosts sits between 9°W and 58°W, and at any other rotation
   * the pins and the crossing arc are on the far side of the sphere.
   */
  const rotation = -1.3 + frame * 0.0026;
  const tilt = 0.06;

  const reveal = interpolate(frame, [0, 26], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  // The dive into Morocco: the globe rushes at camera and blows out to white
  // gold, handing off to Shot 05.
  const dive = interpolate(frame, [DIVE_START, 240], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.bezier(0.6, 0, 0.9, 0.9),
  });
  const cameraDistance = interpolate(dive, [0, 1], [GLOBE_CAMERA.distance, 1.16]);

  // The six hosts occupy the lower-right of the sphere from this angle, so the
  // title block gets its own scrim rather than fighting the arcs for space.

  const pins = useMemo(
    () =>
      PIN_ORDER.map(({id, leader}, i) => {
        const nation = nationById(id);
        return {
          nation,
          index: i,
          leader,
          base: latLonToVec3(nation.city.lonLat[1], nation.city.lonLat[0], 1.01),
        };
      }),
    [],
  );

  const arcs = useMemo(
    () =>
      arcSequence.map(([fromId, toId], i) => ({
        i,
        from: nationById(fromId),
        to: nationById(toId),
        points: greatCircle(
          nationById(fromId).city.lonLat,
          nationById(toId).city.lonLat,
          72,
          // The Atlantic crossing arcs highest — it is the longest hop and the
          // one the whole film is about.
          fromId === 'portugal' ? 0.4 : 0.26,
        ),
      })),
    [],
  );

  // Screen-space projection of the arcs, rotated with the globe. Recomputed per
  // frame so the arcs stay welded to the geometry underneath.
  const projectedArcs = arcs.map((arc) => {
    const pts = arc.points.map((p) => {
      const r = applyGlobeRotation(p, rotation, tilt);
      const s = projectToScreen(r, width, height);
      // Arcs ride above the surface, so they stay visible a little past the
      // horizon; cull on the chord's own depth rather than the sphere test.
      return {...s, visible: r[2] > -0.25};
    });

    // Split into runs of visible points so an arc that passes behind the globe
    // breaks rather than snapping across the frame.
    const runs: {x: number; y: number}[][] = [];
    let current: {x: number; y: number}[] = [];
    for (const p of pts) {
      if (p.visible) {
        current.push({x: p.x, y: p.y});
      } else if (current.length) {
        runs.push(current);
        current = [];
      }
    }
    if (current.length) runs.push(current);

    const d = runs
      .map((run) => run.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' '))
      .join(' ');

    const start = ARC_START + arc.i * ARC_STRIDE;
    const draw = interpolate(frame, [start, start + ARC_DRAW], [0, 1], {
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
      easing: Easing.bezier(0.32, 0, 0.2, 1),
    });

    return {arc, d, draw, isCrossing: arc.from.id === 'portugal'};
  });

  return (
    <AbsoluteFill style={{backgroundColor: palette.ink}}>
      <AbsoluteFill
        style={{
          background: `radial-gradient(circle at 50% 50%, ${palette.atlantic}55 0%, ${palette.ink} 66%)`,
          opacity: reveal,
        }}
      />

      <AbsoluteFill style={{opacity: interpolate(dive, [0.8, 1], [1, 0], {extrapolateLeft: 'clamp'})}}>
        <ThreeCanvas
          width={width}
          height={height}
          camera={{position: [0, 0, cameraDistance], fov: GLOBE_CAMERA.fov}}
          style={{position: 'absolute', inset: 0}}
        >
          <ambientLight intensity={1} />
          <Globe rotation={rotation} tilt={tilt} reveal={reveal} />
        </ThreeCanvas>

        {/* ── Pins and arcs, drawn over the canvas ──────────────────────── */}
        <svg
          width={width}
          height={height}
          style={{position: 'absolute', inset: 0, pointerEvents: 'none'}}
        >
          <defs>
            <filter id="arcGlow" x="-40%" y="-40%" width="180%" height="180%">
              <feGaussianBlur stdDeviation={u(0.5)} result="b" />
              <feMerge>
                <feMergeNode in="b" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>

          {/* Great-circle arcs, drawn with stroke-dashoffset. */}
          {projectedArcs.map(({arc, d, draw, isCrossing}) =>
            draw <= 0 || !d ? null : (
              <path
                key={arc.i}
                d={d}
                fill="none"
                stroke={isCrossing ? palette.goldTrophy : palette.goldLight}
                strokeWidth={u(isCrossing ? 0.32 : 0.22)}
                strokeLinecap="round"
                opacity={isCrossing ? 0.95 : 0.75}
                filter="url(#arcGlow)"
                // A percentage dash pattern lets one dashoffset drive an arc
                // that is split into several visible runs.
                pathLength={1}
                strokeDasharray={`${draw} 1`}
              />
            ),
          )}

          {/* City pins. */}
          {pins.map(({nation, index, base, leader}) => {
            const rotated = applyGlobeRotation(base, rotation, tilt);
            const {x, y, visible} = projectToScreen(rotated, width, height);
            const lit = spring({
              frame: frame - (PIN_START + index * PIN_STRIDE),
              fps,
              config: springs.pop,
              durationInFrames: 22,
            });
            if (lit <= 0.001 || !visible) return null;

            // Pulse ring, retriggered on the beat it lights.
            const age = frame - (PIN_START + index * PIN_STRIDE);
            const pulse = interpolate(age, [0, 34], [0, 1], {
              extrapolateLeft: 'clamp',
              extrapolateRight: 'clamp',
            });

            return (
              <g key={nation.id}>
                <circle
                  cx={x}
                  cy={y}
                  r={u(0.7) + pulse * u(3.4)}
                  fill="none"
                  stroke={palette.goldTrophy}
                  strokeWidth={u(0.16)}
                  opacity={(1 - pulse) * 0.8}
                />
                <circle cx={x} cy={y} r={u(0.72) * lit} fill={palette.goldTrophy} />
                <circle
                  cx={x}
                  cy={y}
                  r={u(1.5) * lit}
                  fill="none"
                  stroke={palette.goldLight}
                  strokeWidth={u(0.1)}
                  opacity={0.6}
                />
                {/* Leader line and label. */}
                <line
                  x1={x}
                  y1={y}
                  x2={x + leader[0] * u(3.2) * lit}
                  y2={y - leader[1] * u(3.2) * lit}
                  stroke={palette.goldLight}
                  strokeWidth={u(0.1)}
                  opacity={0.7 * lit}
                />
                <text
                  x={x + leader[0] * u(3.6)}
                  y={y - leader[1] * u(3.6) + u(0.6)}
                  fill={palette.bone}
                  fontFamily={fontStacks.body}
                  fontSize={u(1.9)}
                  fontWeight={600}
                  letterSpacing={u(0.24)}
                  textAnchor={leader[0] > 0 ? 'start' : 'end'}
                  opacity={lit * 0.95}
                >
                  {nation.city.name.toUpperCase()}
                </text>
              </g>
            );
          })}
        </svg>
      </AbsoluteFill>

      {/* ── Title ────────────────────────────────────────────────────────── */}
      <AbsoluteFill
        style={{
          background: `linear-gradient(to top, ${palette.ink} 4%, ${palette.ink}dd 20%, transparent 46%)`,
          opacity: interpolate(frame, [88, 104], [0, 1], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
          }),
        }}
      />

      <AbsoluteFill
        style={{
          alignItems: 'center',
          justifyContent: 'flex-end',
          padding: `${u(6)}px ${u(6)}px`,
          opacity: interpolate(frame, [DIVE_START - 10, DIVE_START + 14], [1, 0], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
          }),
        }}
      >
        <div style={{display: 'flex', flexDirection: 'column', gap: u(1), alignItems: 'center'}}>
          <TypeLine delay={96} size={pick({landscape: typeScale.title, portrait: typeScale.subtitle * 1.5})} tracking="tight">
            Three Continents
          </TypeLine>
          <TypeLine delay={106} size={pick({landscape: typeScale.title, portrait: typeScale.subtitle * 1.5})} tracking="tight">
            Six Nations
          </TypeLine>
          <TypeLine
            delay={116}
            size={pick({landscape: typeScale.title, portrait: typeScale.subtitle * 1.5})}
            tracking="tight"
            color={palette.goldTrophy}
          >
            One Tournament
          </TypeLine>
          <div
            style={{
              marginTop: u(1.4),
              fontFamily: fontStacks.body,
              fontSize: t(typeScale.caption),
              fontWeight: 500,
              letterSpacing: letterspacing.ultra,
              textTransform: 'uppercase',
              color: palette.bone,
              opacity: interpolate(frame, [132, 148], [0, 0.7], {
                extrapolateLeft: 'clamp',
                extrapolateRight: 'clamp',
              }),
              textAlign: 'center',
            }}
          >
            {nations.map((n) => n.nameEn).join(' · ')}
          </div>
        </div>
      </AbsoluteFill>

      {/* The dive blows out to gold and hands off to Morocco. */}
      <AbsoluteFill
        style={{
          backgroundColor: palette.goldLight,
          opacity: interpolate(dive, [0.72, 0.94, 1], [0, 0.9, 0], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
          }),
        }}
      />
    </AbsoluteFill>
  );
};
