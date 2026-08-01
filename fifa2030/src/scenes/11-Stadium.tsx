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
import {nationById} from '../config/nations';
import {flagByCode} from '../config/flags';
import {Flag} from '../components/Flag';
import {fontStacks, letterspacing, palette, typeScale} from '../config/theme';
import {Stadium} from '../three/Stadium';
import {PitchAction, PitchFurniture} from '../three/PitchAction';
import {STREET_SCENES, StreetFootball} from '../components/StreetFootball';
import {LensFlare} from '../components/CameraRealism';
import {buildBarrage, Fireworks} from '../components/Fireworks';
import {TrophyLift} from '../three/Trophy';
import {Scoreboard} from '../components/Scoreboard';
import type {TimelineEntry} from '../config/timeline';
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
 *   frames  10–230  the descent, one move
 *   frames  60/120/180  flash inserts on beats 4, 8, 12
 *   frame     232   THE GOAL — Uruguay score, the bowl erupts
 *   frames 244–286  FULL TIME: Uruguay 2–1 Argentina
 *   frames 286–360  the trophy is lifted, and the sky goes up with it
 */

const BEAT = 15;
const FLASH_FRAMES = [BEAT * 4, BEAT * 8, BEAT * 12];
const FLASH_LENGTH = 11;

/** The goal lands here; everything after it is celebration. */
const GOAL = 232;
const FULLTIME = 244;
const LIFT = 286;

/**
 * The 2030 opening match, invented for the film: Uruguay beat Argentina at the
 * Estadio Centenario, a hundred years after they beat them there in the first
 * final. Shaped as a TimelineEntry so it renders through the same broadcast
 * Scoreboard the century used — the film's last result is presented exactly
 * like its first.
 */
const OPENING_MATCH: TimelineEntry = {
  year: 2030,
  host: 'Uruguay',
  winner: 'Uruguay',
  final: {
    runnerUp: 'Argentina',
    score: '2-1',
    venue: 'Estadio Centenario, Montevideo',
  },
};

/** Two waves of shells: one on the goal, a bigger barrage on the lift. */
const GOAL_SHELLS = buildBarrage({
  start: GOAL + 4,
  count: 5,
  stagger: 7,
  seed: 'goal',
  yRange: [0.1, 0.3],
  scale: 0.9,
});
const LIFT_SHELLS = buildBarrage({
  start: LIFT - 6,
  count: 16,
  stagger: 4.2,
  seed: 'lift',
  yRange: [0.06, 0.4],
  scale: 1.25,
  colors: ['#D4A73C', '#F2D998', '#F4EFE6', '#5FA8E8', '#8FC7F0'],
});

/**
 * The descent, as an unbroken camera path. Written as one easing over the
 * whole move rather than as segments — the brief calls for a single
 * uninterrupted descent, and any keyframe seam would show as a hitch.
 */
const CameraRig: React.FC<{progress: number; drift: number; celebrate: number}> = ({
  progress,
  drift,
  celebrate,
}) => {
  const camera = useThree((s) => s.camera);

  useLayoutEffect(() => {
    const y = interpolate(progress, [0, 1], [15.5, 0.78]);
    // Lands just outside the touchline (z = 3.2) and well inside the crowd's
    // inner radius, so the stands rise beyond the pitch instead of engulfing
    // the lens.
    const z = interpolate(progress, [0, 1], [13.5, 4.5]);
    // The camera arcs slightly off the halfway line on the way down, then
    // settles back onto it — a straight plumb drop reads as a lift, not a shot.
    const x = Math.sin(progress * Math.PI) * 2.6 + drift * 0.35;

    /**
     * Once the trophy is up, the camera closes in on it. The celebration
     * happens at player scale — roughly a quarter-metre tall in world units —
     * so from the touchline it would be a speck. A broadcast would push in
     * here too; nobody covers a trophy lift in a wide.
     */
    const cx = x + (0.28 - x) * celebrate;
    const cy = y + (0.34 - y) * celebrate;
    const cz = z + (1.55 - z) * celebrate;

    camera.position.set(cx, cy, cz);
    camera.lookAt(
      0,
      interpolate(progress, [0, 1], [0, 0.75]) * (1 - celebrate) + 0.26 * celebrate,
      0.4 * celebrate,
    );
    camera.updateProjectionMatrix();
  }, [camera, progress, drift, celebrate]);

  return null;
};

export const StadiumScene: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const {u, t, width, height, pick} = useLayout();

  // Audio drives the wave. Picture and sound are genuinely locked here: the
  // crowd rises with the score's actual amplitude, not an approximation of it.
  const amplitude = useScoreAmplitude(2160 + frame);

  const descent = interpolate(frame, [10, 230], [0, 1], {
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

  /**
   * The street inserts are now the three beat-flashes only. The fourth used to
   * play as a coda under the final swell, but the swell is the trophy lift —
   * cutting away from a trophy being raised to a dust pitch throws the ending
   * away, and its caption collided with the champions line besides.
   */
  const streetIndex = active ? active.i : 0;
  const street = STREET_SCENES[streetIndex] ?? STREET_SCENES[0]!;
  const streetStrength = active ? active.strength : 0;

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
        <CameraRig
          progress={descent}
          drift={drift}
          celebrate={interpolate(frame, [LIFT - 14, LIFT + 26], [0, 1], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
            easing: Easing.bezier(0.4, 0, 0.2, 1),
          })}
        />
        <Stadium
          wavePhase={wavePhase}
          intensity={waveIntensity}
          reveal={reveal}
          crowdCount={pick({landscape: 26000, portrait: 18000, square: 21000})}
        />
        {/* Key light for the lit figures. The bowl, crowd and pitch all use
            unlit materials, so this only touches the players and the trophy —
            no regression to anything that already looked right. */}
        <directionalLight position={[4, 9, 5]} intensity={1.15} />
        <directionalLight position={[-6, 4, -3]} intensity={0.42} color="#9FC4E8" />

        {/* A real passage of play: build-up, switch, overlap, cross, finish —
            timed so the goal lands on the beat. */}
        <PitchFurniture reveal={reveal} />
        <PitchAction
          t={interpolate(frame, [12, GOAL], [0, 1], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
          })}
          seconds={frame / fps}
          reveal={reveal}
          // Uruguay v Argentina — the two neighbours across the Río de la
          // Plata, and the fixture the whole film has been building toward
          // since the opening 1930 return. Real kit colours, drawn from the
          // same nation config as everything else in the film.
          homeKit={nationById('uruguay').colors.panel}
          awayKit="#F4EFE6"
        />

        {/* The lift. Placed on the halfway line so the descent lands on it. */}
        {frame >= LIFT - 20 ? (
          <group position={[0, 0, 0.4]}>
            <TrophyLift
              t={interpolate(frame, [LIFT, LIFT + 54], [0, 1], {
                extrapolateLeft: 'clamp',
                extrapolateRight: 'clamp',
              })}
              seconds={frame / fps}
              kit={nationById('uruguay').colors.panel}
            />
          </group>
        ) : null}
      </ThreeCanvas>

      {/* Broadcast fixture bug — the two flags, up front, in colour. This is
          the shot's whole "real match" argument made legible at a glance,
          the way a live broadcast always opens on the teams. */}
      <AbsoluteFill
        style={{
          alignItems: 'center',
          justifyContent: 'flex-start',
          paddingTop: u(6),
          opacity: interpolate(frame, [26, 44, 210, 230], [0, 1, 1, 0], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
          }),
          pointerEvents: 'none',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: u(1.4),
            padding: `${u(0.9)}px ${u(1.8)}px`,
            borderRadius: u(0.5),
            backgroundColor: 'rgba(5,11,8,0.68)',
            border: `${u(0.1)}px solid rgba(212,167,60,0.4)`,
          }}
        >
          <div style={{width: u(3.4), height: u(2.27)}}>
            <Flag spec={flagByCode('URU')!} bordered={false} wave={frame * 0.04} waveAmount={0.06} />
          </div>
          <span
            style={{
              fontFamily: fontStacks.display,
              fontSize: t(typeScale.subtitle),
              color: palette.bone,
              letterSpacing: letterspacing.tight,
              textTransform: 'uppercase',
            }}
          >
            Uruguay
          </span>
          <span
            style={{
              fontFamily: fontStacks.display,
              fontSize: t(typeScale.subtitle),
              color: palette.goldTrophy,
              opacity: 0.7,
              margin: `0 ${u(0.3)}px`,
            }}
          >
            v
          </span>
          <span
            style={{
              fontFamily: fontStacks.display,
              fontSize: t(typeScale.subtitle),
              color: palette.bone,
              letterSpacing: letterspacing.tight,
              textTransform: 'uppercase',
            }}
          >
            Argentina
          </span>
          <div style={{width: u(3.4), height: u(2.27)}}>
            <Flag spec={flagByCode('ARG')!} bordered={false} wave={frame * 0.04 + 2} waveAmount={0.06} />
          </div>
        </div>
      </AbsoluteFill>

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

      {/* Floodlights catching the lens during the wide aerial — strongest at
          the top of the descent, fading as the camera drops below the roof
          line and the lights move out of frame. */}
      {[{x: 0.14, y: 0.1}, {x: 0.86, y: 0.1}, {x: 0.5, y: 0.04}].map((pos, i) => (
        <LensFlare
          key={i}
          origin={pos}
          strength={
            reveal *
            interpolate(descent, [0, 0.35, 0.6], [0.55, 0.3, 0], {
              extrapolateLeft: 'clamp',
              extrapolateRight: 'clamp',
            })
          }
          streak={18}
        />
      ))}

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

      {/* The line that makes the argument explicit — moved ahead of the goal
          so the finale is uninterrupted once it starts. */}
      <AbsoluteFill
        style={{
          alignItems: 'center',
          justifyContent: 'center',
          opacity: interpolate(frame, [186, 200, 218, 230], [0, 1, 1, 0], {
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

      {/* THE GOAL — a hard white flash on the frame the ball crosses the line,
          which is how a goal actually registers on a broadcast cut. */}
      <AbsoluteFill
        style={{
          backgroundColor: palette.bone,
          opacity: interpolate(frame, [GOAL, GOAL + 2, GOAL + 12], [0, 0.5, 0], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
          }),
          mixBlendMode: 'screen',
          pointerEvents: 'none',
        }}
      />

      {/* FULL TIME, on the same broadcast board the century used. */}
      <AbsoluteFill
        style={{
          alignItems: 'center',
          justifyContent: 'center',
          padding: `${u(6)}px`,
          opacity: interpolate(frame, [FULLTIME, FULLTIME + 12, LIFT - 8, LIFT + 4], [0, 1, 1, 0], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
          }),
          pointerEvents: 'none',
        }}
      >
        <div style={{display: 'flex', flexDirection: 'column', alignItems: 'center', gap: u(1.4)}}>
          <span
            style={{
              fontFamily: fontStacks.body,
              fontSize: t(typeScale.micro),
              fontWeight: 700,
              letterSpacing: letterspacing.ultra,
              textTransform: 'uppercase',
              color: palette.goldTrophy,
            }}
          >
            Full Time
          </span>
          <Scoreboard entry={OPENING_MATCH} delay={FULLTIME} />
        </div>
      </AbsoluteFill>

      {/* The sky goes up with the trophy. */}
      <Fireworks shells={GOAL_SHELLS} frame={frame} opacity={0.9} />
      <Fireworks shells={LIFT_SHELLS} frame={frame} />

      {/* Champions line, under the lift. */}
      <AbsoluteFill
        style={{
          alignItems: 'center',
          justifyContent: 'flex-end',
          padding: `${u(7)}px`,
          opacity: interpolate(frame, [LIFT + 22, LIFT + 36, 348, 360], [0, 1, 1, 0], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
          }),
          pointerEvents: 'none',
        }}
      >
        <div style={{display: 'flex', flexDirection: 'column', alignItems: 'center', gap: u(0.8)}}>
          <span
            style={{
              fontFamily: fontStacks.display,
              fontSize: t(typeScale.title),
              textTransform: 'uppercase',
              letterSpacing: letterspacing.tight,
              color: palette.goldTrophy,
              textShadow: `0 ${u(0.3)}px ${u(2.4)}px rgba(212,167,60,0.45)`,
            }}
          >
            Uruguay
          </span>
          <span
            style={{
              fontFamily: fontStacks.body,
              fontSize: t(typeScale.caption),
              fontWeight: 600,
              letterSpacing: letterspacing.ultra,
              textTransform: 'uppercase',
              color: palette.bone,
              opacity: 0.85,
              textAlign: 'center',
            }}
          >
            Where it began · Where it returns
          </span>
        </div>
      </AbsoluteFill>

    </AbsoluteFill>
  );
};
