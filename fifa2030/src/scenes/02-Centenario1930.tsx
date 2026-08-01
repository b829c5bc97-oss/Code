import {useThree} from '@react-three/fiber';
import {ThreeCanvas} from '@remotion/three';
import {useLayoutEffect, useMemo} from 'react';
import * as THREE from 'three';
import {
  AbsoluteFill,
  Easing,
  interpolate,
  random,
  useCurrentFrame,
} from 'remotion';
import {useLayout} from '../config/layout';
import {fontStacks, letterspacing, palette, typeScale} from '../config/theme';
import {TypeLine} from '../components/TypeLockup';

/**
 * SHOT 02 — ESTADIO CENTENARIO, 1930 (0:06 – 0:14 | frames 180–420)
 *
 * A low-poly reconstruction of the ground that staged the first World Cup
 * final, sepia-graded and heavy with grain, letterboxed to 4:3 inside the
 * 16:9 frame. The camera pushes through the stands toward the pitch, and on
 * the last beat the bars slide away and colour floods in — the film stepping
 * out of 1930 and into the present.
 *
 * The Torre de los Homenajes is the whole point of the reconstruction: it is
 * what makes this ground unmistakable, and Shot 11's roof-ring mast answers it
 * ninety minutes of football and a hundred years later.
 *
 *   frames   0– 30  fade up from the first touch
 *   frames   0–190  the push through the stands
 *   frames  40–150  "WHERE IT ALL BEGAN"
 *   frames 186–240  letterbox opens, colour floods, hand off to the timeline
 */

const COLOUR_FLOOD = 186;

/** Period crowd: sparse, and standing in long coats. */
const PeriodCrowd: React.FC<{count: number; sepia: number}> = ({count, sepia}) => {
  const object = useMemo(() => {
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const mat = new THREE.MeshBasicMaterial({toneMapped: false});
    const mesh = new THREE.InstancedMesh(geo, mat, count);
    const dummy = new THREE.Object3D();
    const colour = new THREE.Color();

    for (let i = 0; i < count; i++) {
      const angle = random(`c-ang-${i}`) * Math.PI * 2;
      const tier = Math.sqrt(random(`c-tier-${i}`));
      const radius = 6.2 + tier * 4.4;
      dummy.position.set(
        Math.cos(angle) * radius,
        tier * 3.6 + 0.2,
        Math.sin(angle) * radius,
      );
      const s = 0.05 + random(`c-s-${i}`) * 0.025;
      dummy.scale.set(s, s * 2.2, s);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);

      // 1930 crowd: hats and overcoats. Bone through to near-black, nothing
      // saturated — the colour arrives with the modern era, not before it.
      const v = 0.16 + random(`c-v-${i}`) * 0.34;
      mesh.setColorAt(i, colour.setRGB(v, v * 0.92, v * 0.74));
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    return mesh;
  }, [count]);

  useLayoutEffect(() => {
    const mat = object.material as THREE.MeshBasicMaterial;
    mat.opacity = sepia;
    mat.transparent = true;
  }, [object, sepia]);

  return <primitive object={object} />;
};

const Centenario: React.FC<{reveal: number}> = ({reveal}) => {
  const pitchLines = useMemo(() => {
    const pts: number[] = [];
    const y = 0.02;
    const push = (x1: number, z1: number, x2: number, z2: number) =>
      pts.push(x1, y, z1, x2, y, z2);
    push(-4.6, -3.0, 4.6, -3.0);
    push(-4.6, 3.0, 4.6, 3.0);
    push(-4.6, -3.0, -4.6, 3.0);
    push(4.6, -3.0, 4.6, 3.0);
    push(0, -3.0, 0, 3.0);
    for (let i = 0; i < 48; i++) {
      const a1 = (i / 48) * Math.PI * 2;
      const a2 = ((i + 1) / 48) * Math.PI * 2;
      push(Math.cos(a1) * 0.92, Math.sin(a1) * 0.92, Math.cos(a2) * 0.92, Math.sin(a2) * 0.92);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pts), 3));
    return g;
  }, []);

  return (
    <group>
      {/* Pitch. */}
      <mesh rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[11, 7]} />
        <meshBasicMaterial color="#6B6350" transparent opacity={reveal} />
      </mesh>
      <lineSegments geometry={pitchLines}>
        <lineBasicMaterial color="#E8DFC8" transparent opacity={0.5 * reveal} />
      </lineSegments>

      {/* Low-poly stand: an open truncated cone, deliberately faceted. */}
      <mesh position={[0, 1.9, 0]}>
        <cylinderGeometry args={[10.8, 6.0, 3.9, 22, 1, true]} />
        <meshBasicMaterial
          color="#3A3428"
          side={THREE.BackSide}
          transparent
          opacity={reveal}
        />
      </mesh>
      {/* Terrace steps. */}
      {Array.from({length: 7}, (_, i) => (
        <mesh key={i} position={[0, 0.45 + i * 0.52, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[6.1 + i * 0.66, 6.5 + i * 0.66, 22]} />
          <meshBasicMaterial
            color={i % 2 ? '#4A422F' : '#413A2A'}
            side={THREE.DoubleSide}
            transparent
            opacity={reveal}
          />
        </mesh>
      ))}

      <PeriodCrowd count={2600} sepia={reveal} />

      {/*
       * TORRE DE LOS HOMENAJES — the Tribute Tower. Art-deco, stepped, and the
       * single feature that identifies this ground anywhere in the world.
       */}
      <group position={[0, 0, -12.2]}>
        {[
          {w: 2.4, h: 6.4, y: 3.2},
          {w: 1.7, h: 4.0, y: 8.4},
          {w: 1.1, h: 3.0, y: 11.9},
        ].map((seg, i) => (
          <mesh key={i} position={[0, seg.y, 0]}>
            <boxGeometry args={[seg.w, seg.h, seg.w]} />
            <meshBasicMaterial color="#8E856B" transparent opacity={reveal} />
          </mesh>
        ))}
        {/* Vertical fins — the tower's deco ribbing. */}
        {[-0.8, 0, 0.8].map((x) => (
          <mesh key={x} position={[x, 6.4, 1.25]}>
            <boxGeometry args={[0.16, 11.6, 0.1]} />
            <meshBasicMaterial color="#B4A98A" transparent opacity={reveal} />
          </mesh>
        ))}
        <mesh position={[0, 14.1, 0]}>
          <coneGeometry args={[0.8, 1.4, 4]} />
          <meshBasicMaterial color="#B4A98A" transparent opacity={reveal} />
        </mesh>
      </group>

      {/* Floodlight pylons of the period — lattice masts, not modern rigs. */}
      {[-1, 1].map((sx) =>
        [-1, 1].map((sz) => (
          <mesh key={`${sx}-${sz}`} position={[sx * 8.4, 3.1, sz * 6.2]}>
            <boxGeometry args={[0.12, 6.2, 0.12]} />
            <meshBasicMaterial color="#6E6752" transparent opacity={reveal} />
          </mesh>
        )),
      )}
    </group>
  );
};

/** The push through the stands, toward the pitch. One continuous move. */
const PushRig: React.FC<{progress: number}> = ({progress}) => {
  const camera = useThree((s) => s.camera);
  useLayoutEffect(() => {
    /**
     * The push stays OUTSIDE and ABOVE the terrace lip throughout, ending just
     * over the near stand looking across the pitch to the tower.
     *
     * An earlier version ended at pitch level inside the bowl and the camera
     * passed through the terrace geometry — from in there you see the backs of
     * the stands and an edge-on pitch plane, not a stadium.
     */
    camera.position.set(
      interpolate(progress, [0, 1], [1.2, 0.4]),
      interpolate(progress, [0, 1], [13.5, 4.6]),
      interpolate(progress, [0, 1], [21.0, 11.4]),
    );
    // Framed high at the start so the tower's finial clears the letterbox, then
    // settling onto the pitch as the push lands.
    camera.lookAt(0, interpolate(progress, [0, 1], [3.4, 0.3]), -2.0);
    camera.updateProjectionMatrix();
  }, [camera, progress]);
  return null;
};

export const Centenario1930: React.FC = () => {
  const frame = useCurrentFrame();
  const {u, t, width, height, pick} = useLayout();

  const reveal = interpolate(frame, [0, 28], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  const push = interpolate(frame, [0, 190], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.bezier(0.34, 0, 0.36, 1),
  });

  /**
   * The colour flood. The letterbox bars slide away and the sepia grade lifts
   * on the same frames — one gesture, not two, so it reads as the film
   * stepping out of the archive rather than as a filter being switched off.
   */
  const flood = interpolate(frame, [COLOUR_FLOOD, 236], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.bezier(0.6, 0, 0.2, 1),
  });

  // 4:3 inside 16:9. In portrait and square the frame is already narrow, so the
  // bars scale to whatever letterboxing that ratio actually needs.
  const barHeight = pick({landscape: height * 0.125, portrait: height * 0.04, square: height * 0.06});

  return (
    <AbsoluteFill style={{backgroundColor: palette.ink}}>
      <AbsoluteFill
        style={{
          // Sepia in 1930, full colour after the flood.
          filter: `sepia(${(1 - flood) * 0.85}) saturate(${0.45 + flood * 0.95}) contrast(${
            1.16 - flood * 0.14
          }) brightness(${0.94 + flood * 0.1})`,
        }}
      >
        <AbsoluteFill
          style={{
            background: `radial-gradient(ellipse at 50% 44%, #2A2418 0%, ${palette.ink} 72%)`,
            opacity: reveal,
          }}
        />
        <ThreeCanvas
          width={width}
          height={height}
          camera={{position: [1.2, 13.5, 21.0], fov: 44, near: 0.1, far: 200}}
          style={{position: 'absolute', inset: 0}}
        >
          <ambientLight intensity={1} />
          <PushRig progress={push} />
          <Centenario reveal={reveal} />
        </ThreeCanvas>

        {/* Archive treatment: heavy grain, gate weave and an occasional flash
            frame. Only present while we are still in 1930. */}
        <AbsoluteFill
          style={{
            opacity: (1 - flood) * (0.06 + (random(`flash-${Math.floor(frame / 2)}`) > 0.94 ? 0.1 : 0)),
            backgroundColor: palette.bone,
            mixBlendMode: 'overlay',
          }}
        />
        {/* Vertical scratch, drifting across the gate. */}
        <div
          style={{
            position: 'absolute',
            top: 0,
            bottom: 0,
            left: `${18 + Math.sin(frame * 0.07) * 6}%`,
            width: u(0.12),
            backgroundColor: palette.bone,
            opacity: (1 - flood) * 0.12,
          }}
        />
      </AbsoluteFill>

      {/* Letterbox bars — 4:3 inside 16:9, sliding away on the flood. */}
      {[0, 1].map((i) => (
        <div
          key={i}
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            [i === 0 ? 'top' : 'bottom']: 0,
            height: barHeight,
            backgroundColor: '#000000',
            transform: `translateY(${(i === 0 ? -1 : 1) * flood * barHeight}px)`,
          }}
        />
      ))}

      {/* Title. */}
      <AbsoluteFill
        style={{
          alignItems: 'center',
          justifyContent: 'flex-end',
          padding: `${barHeight + u(5)}px ${u(7)}px`,
          opacity: interpolate(frame, [40, 58, 150, 168], [0, 1, 1, 0], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
          }),
        }}
      >
        <div style={{display: 'flex', flexDirection: 'column', alignItems: 'center', gap: u(1.2)}}>
          <TypeLine delay={40} size={typeScale.title} tracking="tight" color={palette.bone}>
            Where It All Began
          </TypeLine>
          <span
            style={{
              fontFamily: fontStacks.body,
              fontSize: t(typeScale.caption),
              fontWeight: 500,
              letterSpacing: letterspacing.ultra,
              textTransform: 'uppercase',
              color: palette.bone,
              opacity: interpolate(frame, [58, 74], [0, 0.72], {
                extrapolateLeft: 'clamp',
                extrapolateRight: 'clamp',
              }),
              textAlign: 'center',
            }}
          >
            Estadio Centenario · 30 July 1930
          </span>
        </div>
      </AbsoluteFill>

      {/* The flood itself: a wash of light as the century turns over. */}
      <AbsoluteFill
        style={{
          backgroundColor: palette.bone,
          opacity: interpolate(flood, [0, 0.42, 1], [0, 0.34, 0], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
          }),
          mixBlendMode: 'screen',
          pointerEvents: 'none',
        }}
      />
    </AbsoluteFill>
  );
};
