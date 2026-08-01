import {useMemo} from 'react';
import {interpolatePath, scalePath, translatePath, getBoundingBox} from '@remotion/paths';
import {
  AbsoluteFill,
  Easing,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import {useLayout} from '../config/layout';
import {nations} from '../config/nations';
import {palette, springs, typeScale} from '../config/theme';
import {
  ASSEMBLY_PITCH,
  ASSEMBLY_YAW,
  hostPanels,
  PANELS,
  panelPath,
  type Panel,
} from '../lib/ball';
import {flags} from '../config/flags';
import {FlagField} from '../components/Flag';
import {GoldParticles} from '../components/GoldParticles';
import {TypeLine} from '../components/TypeLockup';

/**
 * SHOT 12 — UNITY / LOGO LOCKUP (1:24 – 1:30 | frames 2520–2700)
 *
 * The six host outlines fly in and morph — genuinely, via path interpolation —
 * into six panels of a single football. The ball then turns once, catches a
 * gold specular, and settles under the lockup.
 *
 * Beat map (local frames):
 *   0–26    outlines fly in, staggered every 4 frames
 *   26–62   each outline morphs into its panel
 *   50–86   the remaining 26 panels fill in from the centre outward
 *   72–132  one full rotation, decelerating to rest
 *   96      specular sweep
 *   100/114/128  the three type lines resolve
 *   132–165 hold
 *   165–180 fade to black
 */

const BALL_RADIUS = 100;
const VIEW = 258; // viewBox is -129..129 in ball space

/** Where each nation's outline enters from, as a fraction of the frame. */
const ENTRY: [number, number][] = [
  [0, -1.5],
  [1.5, -0.9],
  [1.7, 0.9],
  [0, 1.6],
  [-1.7, 0.9],
  [-1.6, -0.8],
];

/**
 * Fit a nation's 100×100 outline into the space its target panel occupies, so
 * the morph is a shape change rather than a jump in size or position.
 */
const fitOutlineToPanel = (outline: string, panel: Panel): string => {
  const target = panelPath(panel, ASSEMBLY_YAW, ASSEMBLY_PITCH, BALL_RADIUS);
  const box = getBoundingBox(target.d);
  const span = Math.max(box.x2 - box.x1, box.y2 - box.y1);
  // Outlines read best a touch larger than the panel they resolve into.
  const scale = (span * 1.02) / 100;
  const scaled = scalePath(outline, scale, scale);
  const sBox = getBoundingBox(scaled);
  return translatePath(
    scaled,
    target.centroid[0] - (sBox.x1 + sBox.x2) / 2,
    target.centroid[1] - (sBox.y1 + sBox.y2) / 2,
  );
};

/** Same fit, but against the panel's current rotated position. */
const fitOutlineToPanelLive = (
  outline: string,
  panel: Panel,
  yaw: number,
  pitch: number,
): string => {
  const target = panelPath(panel, yaw, pitch, BALL_RADIUS);
  const box = getBoundingBox(target.d);
  const w = box.x2 - box.x1;
  const h = box.y2 - box.y1;
  // Foreshortening squashes the panel; the engraving squashes with it.
  const sx = (w * 0.78) / 100;
  const sy = (h * 0.78) / 100;
  const scaled = scalePath(outline, sx, sy);
  const sBox = getBoundingBox(scaled);
  return translatePath(
    scaled,
    target.centroid[0] - (sBox.x1 + sBox.x2) / 2,
    target.centroid[1] - (sBox.y1 + sBox.y2) / 2,
  );
};

export const UnityLockup: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const {u, t, pick, isPortrait} = useLayout();

  const hosts = useMemo(() => hostPanels(ASSEMBLY_YAW, ASSEMBLY_PITCH), []);
  const hostIndices = useMemo(() => new Set(hosts.map((p) => p.index)), [hosts]);

  /**
   * Uruguay takes the centre pentagon — the tournament opens at the Estadio
   * Centenario, so the ball is built outward from where it began.
   *
   * The five hexagons around it alternate warm and cool so no two neighbouring
   * panels collapse into each other at broadcast distance.
   */
  const assignment = useMemo(() => {
    const ring = ['morocco', 'portugal', 'argentina', 'spain', 'paraguay'];
    const order = ['uruguay', ...ring].map((id) => nations.find((n) => n.id === id)!);
    return order.map((nation, i) => ({
      nation,
      panel: hosts[i]!,
      fitted: fitOutlineToPanel(nation.outline, hosts[i]!),
    }));
  }, [hosts]);

  // ── Ball rotation: assembles still, turns once, decelerates to rest. ──────
  const spin = interpolate(frame, [72, 132], [0, Math.PI * 2], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.bezier(0.16, 0.72, 0.16, 1),
  });
  const yaw = ASSEMBLY_YAW + spin;
  const pitch = ASSEMBLY_PITCH;

  // Camera push-in never fully stops — the frame is alive to the last beat.
  const settle = spring({frame: frame - 24, fps, config: springs.settle, durationInFrames: 60});
  const ballScale = interpolate(settle, [0, 1], [0.86, 1]) * (1 + frame * 0.00028);

  const ballDiameter = pick({
    landscape: u(52),
    portrait: u(70),
    square: u(62),
  });

  // A single gold highlight sweeps across the ball and is gone. It must fade
  // at both ends, or the band parks on the sphere and reads as a paint stripe.
  const specular = interpolate(frame, [88, 118], [-1.5, 1.5], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.bezier(0.4, 0, 0.2, 1),
  });
  const specularOpacity = interpolate(frame, [88, 96, 110, 118], [0, 1, 1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  const fadeOut = interpolate(frame, [165, 180], [1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  // Panels that aren't a host nation fill in from the centre outward.
  const fillerPanels = useMemo(() => {
    const others = PANELS.filter((p) => !hostIndices.has(p.index));
    return others
      .map((p) => ({
        panel: p,
        // Distance from the flower centre drives the stagger.
        dist: Math.hypot(
          ...(panelPath(p, ASSEMBLY_YAW, ASSEMBLY_PITCH, BALL_RADIUS).centroid as [
            number,
            number,
          ]),
        ),
      }))
      .sort((a, b) => a.dist - b.dist);
  }, [hostIndices]);

  return (
    <AbsoluteFill style={{backgroundColor: palette.ink, opacity: fadeOut}}>
      {/* Pitch-deep glow behind the ball so it doesn't float on flat black. */}
      <AbsoluteFill
        style={{
          background: `radial-gradient(circle at 50% ${
            isPortrait ? 36 : 42
          }%, ${palette.pitchDeep} 0%, ${palette.ink} 62%)`,
          opacity: interpolate(frame, [0, 40], [0, 1], {extrapolateRight: 'clamp'}),
        }}
      />

      {/*
        THE WORLD, BEHIND THE BALL.

        Every flag rises behind the lockup as the type resolves. The motto is
        "Football Unites the World" — that has to be shown, not just set in
        type, and this is the frame that shows it.
      */}
      <AbsoluteFill
        style={{
          alignItems: 'center',
          justifyContent: 'center',
          opacity: interpolate(frame, [86, 116, 168, 180], [0, 0.85, 0.85, 0], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
          }),
          transform: `scale(${1 + frame * 0.0004})`,
        }}
      >
        <FlagField
          specs={flags}
          t={frame / fps}
          reveal={interpolate(frame, [86, 150], [0, 1], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
          })}
          columns={pick({landscape: 10, portrait: 6, square: 8})}
          size={pick({landscape: u(9.5), portrait: u(13), square: u(11)})}
          gap={u(1.5)}
        />
      </AbsoluteFill>

      {/* Scrim so the ball and the lockup stay clear of the flag wall. */}
      <AbsoluteFill
        style={{
          // Tight to the lockup only. A full-frame scrim buries the flag wall
          // entirely, which defeats the point of putting it there.
          background: `radial-gradient(ellipse ${
            isPortrait ? 64 : 38
          }% 54% at 50% ${isPortrait ? 42 : 48}%, ${palette.ink}f7 0%, ${palette.ink}e0 52%, transparent 100%)`,
          opacity: interpolate(frame, [86, 112], [0, 1], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
          }),
        }}
      />

      <AbsoluteFill
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: pick({landscape: u(3), portrait: u(6)}),
          padding: `${u(4)}px ${u(8)}px`,
        }}
      >
        {/* ── The ball ─────────────────────────────────────────────────── */}
        <div
          style={{
            width: ballDiameter,
            height: ballDiameter,
            transform: `scale(${ballScale})`,
            flexShrink: 0,
          }}
        >
          <svg
            viewBox={`${-VIEW / 2} ${-VIEW / 2} ${VIEW} ${VIEW}`}
            width="100%"
            height="100%"
            style={{overflow: 'visible'}}
          >
            <defs>
              <radialGradient id="ballShade" cx="38%" cy="30%" r="78%">
                <stop offset="0%" stopColor="#ffffff" stopOpacity="0.24" />
                <stop offset="55%" stopColor="#ffffff" stopOpacity="0.02" />
                <stop offset="100%" stopColor="#000000" stopOpacity="0.55" />
              </radialGradient>
              <linearGradient id="specular" x1="0" y1="0" x2="1" y2="0.4">
                <stop offset="0%" stopColor={palette.goldLight} stopOpacity="0" />
                <stop offset="48%" stopColor={palette.goldLight} stopOpacity="0.85" />
                <stop offset="100%" stopColor={palette.goldLight} stopOpacity="0" />
              </linearGradient>
              <clipPath id="ballClip">
                <circle cx="0" cy="0" r={BALL_RADIUS * 1.005} />
              </clipPath>
              {/* One clip per host panel, so an engraved country can never
                  spill over its own panel edge as the ball turns. */}
              {assignment.map(({nation, panel}) => (
                <clipPath key={`clip-${nation.id}`} id={`panelClip-${nation.id}`}>
                  <path d={panelPath(panel, yaw, pitch, BALL_RADIUS).d} />
                </clipPath>
              ))}
            </defs>

            {/* Sphere base, revealed as the panels arrive. */}
            <circle
              cx="0"
              cy="0"
              r={BALL_RADIUS}
              fill={palette.ink}
              opacity={interpolate(frame, [40, 70], [0, 1], {
                extrapolateLeft: 'clamp',
                extrapolateRight: 'clamp',
              })}
            />

            <g clipPath="url(#ballClip)">
              {/* Non-host panels fill in from the centre outward. */}
              {fillerPanels.map(({panel}, i) => {
                const delay = 50 + i * 1.3;
                const p = spring({
                  frame: frame - delay,
                  fps,
                  config: springs.snap,
                  durationInFrames: 22,
                });
                if (p <= 0.001) return null;
                const geo = panelPath(panel, yaw, pitch, BALL_RADIUS);
                if (geo.facing <= 0.02) return null;
                const shade = 0.35 + geo.facing * 0.65;
                return (
                  <path
                    key={`f-${panel.index}`}
                    d={geo.d}
                    // Pentagons stay dark, hexagons take the pitch green: the
                    // familiar football read, in the film's own palette.
                    fill={panel.kind === 'pentagon' ? palette.ink : palette.pitchDeep}
                    stroke={palette.goldTrophy}
                    strokeWidth={1.1}
                    strokeOpacity={0.72 * shade * p}
                    fillOpacity={p}
                    style={{transformOrigin: 'center', transform: `scale(${0.7 + p * 0.3})`}}
                  />
                );
              })}

              {/* The six host nations. */}
              {assignment.map(({nation, panel, fitted}, i) => {
                const flyDelay = i * 4;
                const fly = spring({
                  frame: frame - flyDelay,
                  fps,
                  config: springs.settle,
                  durationInFrames: 34,
                });
                const morph = interpolate(frame, [26 + i * 4, 62 + i * 4], [0, 1], {
                  extrapolateLeft: 'clamp',
                  extrapolateRight: 'clamp',
                  easing: Easing.bezier(0.5, 0, 0.2, 1),
                });

                const entry = ENTRY[i] ?? [0, -1.5];
                const tx = interpolate(fly, [0, 1], [entry[0] * VIEW * 0.75, 0]);
                const ty = interpolate(fly, [0, 1], [entry[1] * VIEW * 0.6, 0]);
                const rot = interpolate(fly, [0, 1], [(i % 2 ? 1 : -1) * 34, 0]);

                // Once assembled, the panel follows the ball's rotation.
                const live = panelPath(panel, yaw, pitch, BALL_RADIUS);
                const resting = panelPath(panel, ASSEMBLY_YAW, ASSEMBLY_PITCH, BALL_RADIUS);
                const shape =
                  morph >= 1
                    ? live.d
                    : interpolatePath(morph, fitted, resting.d);

                if (morph >= 1 && live.facing <= 0.02) return null;

                const facing = morph >= 1 ? live.facing : 1;
                const shade = 0.4 + facing * 0.6;

                // Once assembled, the country stays engraved inside its panel —
                // without it the ball is just coloured tiles, and the whole
                // point of the shot is that six nations made this one object.
                const engraved =
                  morph >= 1 ? fitOutlineToPanelLive(nation.outline, panel, yaw, pitch) : null;

                return (
                  <g
                    key={nation.id}
                    transform={`translate(${tx} ${ty}) rotate(${rot})`}
                    opacity={interpolate(fly, [0, 0.2, 1], [0, 1, 1])}
                  >
                    <path
                      d={shape}
                      fill={nation.colors.panel}
                      fillOpacity={interpolate(morph, [0, 0.55, 1], [0.1, 0.55, 0.94]) * shade}
                      stroke={palette.goldTrophy}
                      strokeWidth={interpolate(morph, [0, 1], [2.2, 1.1])}
                      strokeOpacity={shade}
                      strokeLinejoin="round"
                    />
                    {engraved ? (
                      <path
                        d={engraved}
                        fill="none"
                        stroke={palette.goldLight}
                        strokeWidth={0.9}
                        strokeOpacity={0.5 * facing}
                        strokeLinejoin="round"
                        clipPath={`url(#panelClip-${nation.id})`}
                      />
                    ) : null}
                  </g>
                );
              })}

              {/* Sphere shading and the specular sweep, over the panels. */}
              <circle cx="0" cy="0" r={BALL_RADIUS} fill="url(#ballShade)" />
              <rect
                x={-VIEW * 0.28}
                y={-VIEW}
                width={VIEW * 0.56}
                height={VIEW * 2}
                fill="url(#specular)"
                opacity={specularOpacity}
                transform={`translate(${specular * VIEW * 0.72} 0) rotate(14)`}
                style={{mixBlendMode: 'screen'}}
              />
            </g>

            {/* Rim light — the ball reads as a solid object, not a disc. */}
            <circle
              cx="0"
              cy="0"
              r={BALL_RADIUS}
              fill="none"
              stroke={palette.goldTrophy}
              strokeWidth={1.4}
              strokeOpacity={interpolate(frame, [60, 90], [0, 0.55], {
                extrapolateLeft: 'clamp',
                extrapolateRight: 'clamp',
              })}
            />
          </svg>
        </div>

        {/* ── The lockup ───────────────────────────────────────────────── */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: `${u(1.4)}px`,
            width: '100%',
          }}
        >
          <TypeLine delay={100} size={typeScale.title} tracking="tight" color={palette.bone}>
            FIFA World Cup 2030™
          </TypeLine>

          <TypeLine
            delay={114}
            size={typeScale.display}
            tracking="tight"
            color={palette.goldTrophy}
            mode="letterpress"
            tabular
          >
            100 Years
          </TypeLine>

          <div style={{marginTop: u(1.2)}}>
            <TypeLine
              delay={128}
              size={typeScale.subtitle}
              font="body"
              weight={600}
              tracking="ultra"
              color={palette.bone}
              mode="track-in"
              style={{fontSize: t(typeScale.subtitle)}}
            >
              Football Unites the World
            </TypeLine>
          </div>
        </div>
      </AbsoluteFill>

      {/* The gold that was spent on the first touch returns on the last beat. */}
      <GoldParticles
        triggerFrame={96}
        count={90}
        origin={{x: 0.5, y: isPortrait ? 0.36 : 0.42}}
        spread={38}
        gravity={0.18}
        lifetime={64}
      />
    </AbsoluteFill>
  );
};
