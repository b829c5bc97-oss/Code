import {useThree} from '@react-three/fiber';
import {ThreeCanvas} from '@remotion/three';
import {useLayoutEffect} from 'react';
import {
  AbsoluteFill,
  Easing,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import {useLayout} from '../config/layout';
import {fontStacks, letterspacing, palette, typeScale} from '../config/theme';
import {PitchPlayers, Stadium} from '../three/Stadium';
import {STREET_SCENES, StreetFootball} from '../components/StreetFootball';
import {useScoreAmplitude} from '../audio';

/**
 * SHOT 11 — THE STADIUM (1:12 – 1:24 | frames 2160–2520)
 *
 * The emotional payoff. One unbroken camera move from a wide aerial above the
 * roof ring down to eye height on the halfway line, over a bowl of tens of
 * thousands of instanced spectators doing a Mexican wave.
 *
 * Cut into it, on beats 4, 8 and 12, are the frames the whole film is for:
 * ordinary people playing. A rooftop in Casablanca, a beach in Montevideo, an
 * alley in Lisbon, a dust pitch in Asunción. Elite football is the spectacle;
 * this is the game.
 *
 *   frames   0– 20  bowl fades up, wide aerial
 *   frames  10–300  the descent, one move
 *   frames  60/120/180  flash inserts on beats 4, 8, 12
 *   frames 240–300  eye height on the halfway line, slow drift
 *   frames 300–360  crowd swell, hand off to the lockup
 */

const BEAT = 15;
const FLASH_FRAMES = [BEAT * 4, BEAT * 8, BEAT * 12];
const FLASH_LENGTH = 11;

/**
 * The descent, as an unbroken camera path. Written as one easing over the
 * whole move rather than as segments — the brief calls for a single
 * uninterrupted descent, and any keyframe seam would show as a hitch.
 */
const CameraRig: React.FC<{progress: number; drift: number}> = ({progress, drift}) => {
  const camera = useThree((s) => s.camera);

  useLayoutEffect(() => {
    const y = interpolate(progress, [0, 1], [15.5, 0.62]);
    const z = interpolate(progress, [0, 1], [13.5, 6.15]);
    // The camera arcs slightly off the halfway line on the way down, then
    // settles back onto it — a straight plumb drop reads as a lift, not a shot.
    const x = Math.sin(progress * Math.PI) * 2.6 + drift * 0.35;

    camera.position.set(x, y, z);
    // The look-at target rises from the centre spot to standing eye height.
    camera.lookAt(0, interpolate(progress, [0, 1], [0, 0.75]), 0);
    camera.updateProjectionMatrix();
  }, [camera, progress, drift]);

  return null;
};

export const StadiumScene: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const {u, t, width, height, pick} = useLayout();

  // Audio drives the wave. Picture and sound are genuinely locked here: the
  // crowd rises with the score's actual amplitude, not an approximation of it.
  const amplitude = useScoreAmplitude(2160 + frame);

  const descent = interpolate(frame, [10, 300], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.bezier(0.42, 0, 0.28, 1),
  });
  // Never fully still: a slow lateral drift continues after the descent lands.
  const drift = Math.sin(frame * 0.014) * interpolate(descent, [0.85, 1], [0, 1], {
    extrapolateLeft: 'clamp',
  });

  const reveal = interpolate(frame, [0, 22], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  // The wave travels around the bowl roughly once per four bars.
  const wavePhase = frame * 0.052;
  const waveIntensity = 0.55 + amplitude * 1.5;

  const active = FLASH_FRAMES.map((f, i) => ({
    i,
    on: frame >= f && frame < f + FLASH_LENGTH,
    strength: interpolate(frame, [f, f + 2, f + FLASH_LENGTH - 3, f + FLASH_LENGTH], [0, 1, 1, 0], {
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
    }),
  })).find((x) => x.on);

  // The fourth street scene plays out under the final swell rather than as a
  // flash — the film settles on ordinary football before the lockup.
  const codaStrength = interpolate(frame, [306, 318, 340, 352], [0, 1, 1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  const streetIndex = active ? active.i : 3;
  const street = STREET_SCENES[streetIndex] ?? STREET_SCENES[0]!;
  const streetStrength = active ? active.strength : codaStrength;

  return (
    <AbsoluteFill style={{backgroundColor: palette.ink}}>
      {/* Dusk sky behind the bowl. */}
      <AbsoluteFill
        style={{
          background: `linear-gradient(to bottom, ${palette.atlantic} 0%, #10243A 34%, ${palette.ink} 74%)`,
          opacity: reveal * 0.9,
        }}
      />

      <ThreeCanvas
        width={width}
        height={height}
        camera={{position: [0, 15.5, 13.5], fov: 46, near: 0.1, far: 120}}
        style={{position: 'absolute', inset: 0}}
      >
        <ambientLight intensity={1} />
        <CameraRig progress={descent} drift={drift} />
        <Stadium
          wavePhase={wavePhase}
          intensity={waveIntensity}
          reveal={reveal}
          crowdCount={pick({landscape: 26000, portrait: 18000, square: 21000})}
        />
        <PitchPlayers t={frame / fps} reveal={reveal} />
      </ThreeCanvas>

      {/* Roof-ring glow bloom, cheaper and more controllable than a postprocess
          pass at this scale. */}
      <AbsoluteFill
        style={{
          background: `radial-gradient(ellipse at 50% ${interpolate(
            descent,
            [0, 1],
            [46, 22],
          )}%, rgba(212,167,60,${0.16 * reveal}) 0%, transparent 52%)`,
          mixBlendMode: 'screen',
          pointerEvents: 'none',
        }}
      />

      {/* ── Cut inserts: ordinary people playing ─────────────────────────── */}
      {streetStrength > 0.01 ? (
        <AbsoluteFill style={{opacity: streetStrength}}>
          <StreetFootball kind={street.kind} t={frame / fps} />
          <AbsoluteFill
            style={{
              alignItems: 'center',
              justifyContent: 'flex-end',
              padding: u(7),
            }}
          >
            <span
              style={{
                fontFamily: fontStacks.body,
                fontSize: t(typeScale.caption),
                fontWeight: 500,
                textTransform: 'uppercase',
                letterSpacing: letterspacing.ultra,
                color: palette.bone,
                opacity: 0.85,
              }}
            >
              {street.caption}
            </span>
          </AbsoluteFill>
        </AbsoluteFill>
      ) : null}

      {/* The line that makes the argument explicit, under the final swell. */}
      <AbsoluteFill
        style={{
          alignItems: 'center',
          justifyContent: 'center',
          opacity: interpolate(frame, [258, 274, 300, 312], [0, 1, 1, 0], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
          }),
          pointerEvents: 'none',
        }}
      >
        <span
          style={{
            fontFamily: fontStacks.display,
            fontSize: t(typeScale.title),
            textTransform: 'uppercase',
            letterSpacing: letterspacing.tight,
            color: palette.bone,
            textAlign: 'center',
            textShadow: `0 ${u(0.3)}px ${u(2)}px rgba(5,11,8,0.8)`,
          }}
        >
          Everyone&rsquo;s Game
        </span>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
