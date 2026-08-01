import {
  AbsoluteFill,
  Easing,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import {useLayout} from '../config/layout';
import type {Nation} from '../config/nations';
import {fontStacks, letterspacing, palette, shade, typeScale} from '../config/theme';
import {Motif, MOTIF_H, MOTIF_W} from '../components/Motifs';
import {CountryOutline, NationNameLock} from '../components/NationCard';
import {PlayerSilhouette} from '../components/PlayerSilhouette';
import {HexWipe} from '../components/HexWipe';

/**
 * SHOTS 05–10 — THE SIX NATIONS (0:36 – 1:12)
 *
 * One component, six configurations. Every nation gets the identical 180-frame
 * skeleton so the run reads as a single movement rather than six separate
 * cards; only the content inside it changes, and all of that content lives in
 * `config/nations.ts` and `config/players.ts`.
 *
 *   frames   0– 30  country outline draws in gold, then fills with its ornament
 *   frames  30– 90  culture montage — three parallax layers
 *   frames  90–150  the player moment, on the national colour field
 *   frames 150–180  name locks in (English + local script), hexagon wipe out
 */

const PHASE = {outline: 0, montage: 30, player: 90, name: 150, end: 180} as const;

/**
 * Depth roles are fixed across all six nations: landscape behind, architecture
 * or a figure carrying the frame, ornament as foreground texture.
 *
 * The ornament layer is deliberately the quietest. It tiles across the whole
 * frame, so at any real opacity it stops being texture and becomes wallpaper
 * that swallows the two layers doing the actual storytelling.
 */
const PARALLAX = [
  // Far: fills the frame, so it crops (slice) and sits well back in tone.
  {speed: 0.22, opacity: 0.8, scale: 1.14, y: 0.08, density: 1, fit: 'xMidYMid slice'},
  // Mid: the composed motif. It must be seen whole (meet), not cropped — an
  // arcade or a stadium bowl cropped to its middle third stops being either.
  {speed: 0.55, opacity: 0.95, scale: 0.94, y: 0.0, density: 1, fit: 'xMidYMid meet'},
  // Near: ornament texture, edge to edge and very quiet.
  {speed: 1.0, opacity: 0.17, scale: 1.0, y: -0.04, density: 3.2, fit: 'xMidYMid slice'},
] as const;

/**
 * Colour rules per depth, applied identically to all six nations.
 *
 * The mid layer is always a dark silhouette tinted with the national colour —
 * never a bright fill. A stadium bowl or an arcade rendered in a nation's
 * brightest secondary stops reading as architecture and becomes a coloured
 * blob; as a dark mass against the colour field it reads instantly.
 */
const depthColors = (nation: Nation, depth: number) => {
  if (depth === 0) {
    return {
      color: shade(nation.colors.secondary, 0.62),
      accent: shade(nation.colors.field, 0.5),
      line: shade(nation.colors.line, 0.45),
    };
  }
  if (depth === 1) {
    return {
      color: shade(nation.colors.field, 0.5),
      accent: nation.colors.secondary,
      line: nation.colors.line,
    };
  }
  return {
    color: nation.colors.line,
    accent: palette.goldTrophy,
    line: nation.colors.line,
  };
};

export const NationModule: React.FC<{nation: Nation}> = ({nation}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const {u, t, pick, isPortrait, width} = useLayout();

  // ── Phase progressions ───────────────────────────────────────────────────
  const draw = interpolate(frame, [PHASE.outline, PHASE.outline + 22], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.bezier(0.4, 0, 0.2, 1),
  });
  const fillIn = interpolate(frame, [PHASE.outline + 16, PHASE.montage + 6], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  const montage = interpolate(frame, [PHASE.montage, PHASE.player], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  // The player moment eases in and holds its follow-through — the last third
  // of the action plays slower than the first, the way a replay would.
  const playerProgress = interpolate(frame, [PHASE.player, PHASE.name - 6], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.bezier(0.24, 0.62, 0.3, 1),
  });

  // ── Cross-fades between the three beats ──────────────────────────────────
  const outlineOpacity = interpolate(
    frame,
    [PHASE.outline, PHASE.outline + 8, PHASE.montage - 2, PHASE.montage + 12],
    [0, 1, 1, 0],
    {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'},
  );
  const montageOpacity = interpolate(
    frame,
    [PHASE.montage + 4, PHASE.montage + 16, PHASE.player - 4, PHASE.player + 10],
    [0, 1, 1, 0],
    {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'},
  );
  const playerOpacity = interpolate(
    frame,
    [PHASE.player - 6, PHASE.player + 10, PHASE.name + 6, PHASE.name + 20],
    [0, 1, 1, 0.12],
    {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'},
  );

  // Camera never sits still: a constant 3% push across the whole module.
  const push = 1 + interpolate(frame, [0, PHASE.end], [0, 0.03]);

  // Field colour arrives with the module and deepens under the player moment.
  const fieldOpacity = interpolate(
    frame,
    [0, 20, PHASE.player, PHASE.name],
    [0, 0.5, 0.82, 0.9],
    {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'},
  );

  const captionIn = spring({frame: frame - PHASE.montage - 10, fps, durationInFrames: 24});

  return (
    <AbsoluteFill style={{backgroundColor: palette.ink, overflow: 'hidden'}}>
      {/* National colour field. */}
      <AbsoluteFill
        style={{
          background: `radial-gradient(ellipse at 50% 54%, ${nation.colors.field} 0%, ${palette.ink} 82%)`,
          opacity: fieldOpacity,
        }}
      />

      {/* ── BEAT 2 · culture montage, three parallax depths ───────────────── */}
      <AbsoluteFill style={{opacity: montageOpacity, transform: `scale(${push})`}}>
        {PARALLAX.map((layer, i) => {
          // Each depth travels a different distance across the montage — that
          // difference is the parallax.
          const travel = interpolate(montage, [0, 1], [0.16, -0.16]) * layer.speed;
          return (
            <AbsoluteFill
              key={i}
              style={{
                opacity: layer.opacity,
                transform: `translateX(${travel * width}px) translateY(${
                  layer.y * u(10)
                }px) scale(${layer.scale})`,
              }}
            >
              <svg
                viewBox={`0 0 ${MOTIF_W} ${MOTIF_H}`}
                width="100%"
                height="100%"
                preserveAspectRatio={layer.fit}
              >
                <Motif
                  kind={nation.motifs[i] ?? nation.motifs[0]}
                  {...depthColors(nation, i)}
                  progress={montage}
                  uid={`${nation.id}-${i}`}
                  density={layer.density}
                />
              </svg>
            </AbsoluteFill>
          );
        })}

        {/* Motif credits — names the culture on screen instead of leaving it
            to the viewer to guess. */}
        <AbsoluteFill
          style={{
            justifyContent: 'flex-end',
            alignItems: 'center',
            padding: u(7),
            opacity: captionIn * 0.85,
          }}
        >
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: `${u(0.6)}px ${u(2.4)}px`,
              justifyContent: 'center',
              maxWidth: '86%',
            }}
          >
            {nation.motifNotes.map((note, i) => (
              <span
                key={note}
                style={{
                  fontFamily: fontStacks.body,
                  fontSize: t(typeScale.caption),
                  fontWeight: 500,
                  letterSpacing: letterspacing.wide,
                  textTransform: 'uppercase',
                  color: palette.bone,
                  opacity: interpolate(captionIn, [0, 1], [0, 0.75 - i * 0.06]),
                  whiteSpace: 'nowrap',
                }}
              >
                {note}
              </span>
            ))}
          </div>
        </AbsoluteFill>
      </AbsoluteFill>

      {/* ── BEAT 1 · the country draws itself ────────────────────────────── */}
      <AbsoluteFill
        style={{
          opacity: outlineOpacity,
          alignItems: 'center',
          justifyContent: 'center',
          transform: `scale(${push})`,
        }}
      >
        <div
          style={{
            width: pick({landscape: '38%', portrait: '68%', square: '54%'}),
            height: pick({landscape: '58%', portrait: '38%', square: '48%'}),
          }}
        >
          <CountryOutline nation={nation} draw={draw} fill={fillIn} />
        </div>
      </AbsoluteFill>

      {/* ── BEAT 3 · the player moment ───────────────────────────────────── */}
      <AbsoluteFill
        style={{
          opacity: playerOpacity,
          alignItems: 'center',
          justifyContent: 'center',
          transform: `scale(${push})`,
        }}
      >
        <div
          style={{
            width: pick({landscape: '54%', portrait: '96%', square: '76%'}),
            height: pick({landscape: '76%', portrait: '52%', square: '64%'}),
          }}
        >
          <PlayerSilhouette slot={nation.player} progress={playerProgress} />
        </div>
      </AbsoluteFill>

      {/* Action caption, under the player moment. */}
      <AbsoluteFill
        style={{
          alignItems: 'center',
          justifyContent: 'flex-end',
          padding: `${u(9)}px`,
          opacity: interpolate(
            frame,
            [PHASE.player + 8, PHASE.player + 24, PHASE.name - 4, PHASE.name + 8],
            [0, 0.9, 0.9, 0],
            {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'},
          ),
        }}
      >
        <span
          style={{
            fontFamily: fontStacks.body,
            fontSize: t(typeScale.body),
            fontWeight: 500,
            fontStyle: 'italic',
            letterSpacing: letterspacing.wide,
            color: palette.bone,
            textAlign: 'center',
          }}
        >
          {nation.player.signatureAction}
          <span style={{color: palette.goldLight, marginLeft: u(1.4)}}>
            №&nbsp;{nation.player.jerseyNumber}
          </span>
        </span>
      </AbsoluteFill>

      {/* ── BEAT 4 · the name locks in ───────────────────────────────────── */}
      <AbsoluteFill
        style={{
          alignItems: 'center',
          justifyContent: isPortrait ? 'center' : 'flex-end',
          padding: `${u(10)}px ${u(8)}px`,
          opacity: interpolate(frame, [PHASE.name, PHASE.name + 6], [0, 1], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
          }),
        }}
      >
        <NationNameLock nation={nation} delay={PHASE.name} />
      </AbsoluteFill>

      {/* Signature transition out. Continent changes whip the other way, which
          is what makes the Iberia → South America jump feel like a crossing. */}
      <HexWipe
        startFrame={PHASE.end - 16}
        duration={32}
        coverOnly
        direction={nation.id === 'uruguay' ? 'right' : 'left'}
        color={palette.ink}
      />
    </AbsoluteFill>
  );
};
