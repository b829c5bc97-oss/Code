import {useMemo} from 'react';
import {
  AbsoluteFill,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import {useLayout} from '../config/layout';
import {players} from '../config/players';
import {fontStacks, letterspacing, palette, springs, typeScale} from '../config/theme';
import {CENTENARY, worldCups, type TimelineEntry} from '../config/timeline';
import {flagByCode, WINNER_FLAG} from '../config/flags';
import {Flag} from '../components/Flag';
import {PlayerSilhouette} from '../components/PlayerSilhouette';
import {GoldParticles, Shockwave} from '../components/GoldParticles';
import {TypeLine} from '../components/TypeLockup';

/**
 * SHOT 03 — 100 YEARS TIMELINE (0:14 – 0:28 | frames 420–840)
 *
 * A gold rail carrying every World Cup from 1930 to 2026 travels right to
 * left. Six editions get a 1.5-second hero hold where the rail slows almost to
 * a stop and a stylised freeze-frame plays. Then the rail ramps up, blurs, and
 * slams to a halt on 2030.
 *
 * The rail's position is a single monotonic function of frame — it never
 * reverses, so the hero holds read as the film slowing down to look at
 * something rather than as cuts.
 *
 *   frames   0– 12  rail arrives
 *   frames  12–330  the century travels past, with six hero holds
 *   frames 330–372  speed ramp and motion blur
 *   frames 372–420  slam to 2030, "100 YEARS"
 */

const CARD_W = 30; // in layout units
const CARD_GAP = 10;
const STRIDE = CARD_W + CARD_GAP;

/** Front row travels at rail speed; the back row lags, which is the parallax. */
const ROW_PARALLAX = [1, 0.86] as const;

const RAMP_START = 330;
const SLAM = 372;
const END = 420;

/**
 * Rail travel in card-strides, as a function of frame.
 *
 * This is CONSTRUCTED from a schedule rather than integrated from a speed
 * curve. Integrating a speed felt more physical but made the timing emergent,
 * and the emergent answer was wrong: the rail ate the whole century in about
 * forty frames and then sat on empty track until the slam. Building the
 * keyframes explicitly means every hero hold is guaranteed to land on its card
 * and the last edition is guaranteed to arrive exactly at the ramp.
 */
const buildRailCurve = (heroIndices: number[], cardCount: number) => {
  const HOLD = 30; // frames parked on a hero card
  const START = 12;
  /** Index the rail has reached when the speed ramp begins. */
  const lastCruise = Math.max(...heroIndices);

  const holdsBeforeRamp = heroIndices.length;
  const travelFrames = RAMP_START - START - holdsBeforeRamp * HOLD;
  const perStride = travelFrames / Math.max(1, lastCruise);

  // Keyframes of (frame, position-in-strides).
  const keys: {f: number; p: number}[] = [{f: 0, p: 0}];
  let f = START;
  let p = 0;
  keys.push({f, p});

  for (let idx = 0; idx <= lastCruise; idx++) {
    if (idx > 0) {
      f += perStride;
      p = idx;
      keys.push({f, p});
    }
    if (heroIndices.includes(idx)) {
      // Park. Two keys at the same position is what makes it a hold.
      f += HOLD;
      keys.push({f, p});
    }
  }

  // The ramp: everything left flies past, then the rail stops dead on 2030.
  keys.push({f: SLAM, p: cardCount});

  // Sample per frame, easing across each segment so the rail decelerates into
  // a hold and accelerates out of it instead of stepping.
  const samples: number[] = [];
  let k = 0;
  for (let frame = 0; frame <= END; frame++) {
    while (k < keys.length - 2 && frame > keys[k + 1]!.f) k++;
    const a = keys[k]!;
    const b = keys[k + 1]!;
    const span = b.f - a.f;
    const local = span <= 0 ? 1 : Math.max(0, Math.min(1, (frame - a.f) / span));
    // Smoothstep: zero velocity at both ends of every segment.
    const e = local * local * (3 - 2 * local);
    samples.push(a.p + (b.p - a.p) * e);
  }
  return samples;
};

const YearCard: React.FC<{
  entry: TimelineEntry;
  /** The card's own position along the rail, in strides. */
  offset: number;
  /**
   * Signed distance from the rail's focus, in strides. This is what drives
   * fade and highlight — using the raw index instead meant every card past
   * the fifth was permanently dimmed no matter where it sat on screen.
   */
  distance: number;
  row: number;
  blur: number;
  /** Row depth: the back row travels a shorter distance for the same time. */
  parallax: number;
}> = ({entry, offset, distance, row, blur, parallax}) => {
  const {u, t} = useLayout();
  const focused = Math.abs(distance) < 0.5 && Boolean(entry.hero);
  const winnerFlag = entry.winner ? flagByCode(WINNER_FLAG[entry.winner] ?? '') : undefined;
  const proximity = Math.max(0, 1 - Math.abs(distance) / 4.2);

  return (
    <div
      style={{
        position: 'absolute',
        transform: `translateX(${offset * u(STRIDE) * parallax}px)`,
        width: u(CARD_W),
        display: 'flex',
        flexDirection: 'column',
        gap: u(0.7),
        // The two rows sit at different depths and therefore different scales.
        opacity: (entry.cancelled ? 0.5 : 1) * (0.12 + proximity * 0.88),
        filter: blur > 0.15 ? `blur(${blur * u(1.1)}px)` : undefined,
        alignItems: 'flex-start',
        paddingTop: row === 0 ? 0 : u(1.4),
      }}
    >
      <div
        style={{
          fontFamily: fontStacks.display,
          fontSize: t(row === 0 ? typeScale.title : typeScale.subtitle * 1.25),
          lineHeight: 1,
          // Gold is the centenary's colour. Along the rail it marks only the
          // hero editions; every other year is bone.
          color: focused ? palette.goldTrophy : palette.bone,
          fontVariantNumeric: 'tabular-nums',
          fontFeatureSettings: '"tnum" 1',
          letterSpacing: letterspacing.tight,
        }}
      >
        {entry.year}
      </div>

      <div style={{width: '82%', height: u(0.14), backgroundColor: palette.bone, opacity: 0.35}} />

      {entry.cancelled ? (
        <div
          style={{
            fontFamily: fontStacks.body,
            fontSize: t(typeScale.micro),
            fontWeight: 500,
            letterSpacing: letterspacing.wide,
            textTransform: 'uppercase',
            color: palette.bone,
            opacity: 0.75,
            lineHeight: 1.35,
          }}
        >
          Not played
          <br />
          The war years
        </div>
      ) : (
        <div
          style={{
            fontFamily: fontStacks.body,
            fontSize: t(typeScale.micro),
            fontWeight: 500,
            letterSpacing: letterspacing.wide,
            textTransform: 'uppercase',
            color: palette.bone,
            opacity: 0.8,
            lineHeight: 1.4,
          }}
        >
          {entry.host}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: u(0.7),
              marginTop: u(0.35),
              opacity: 0.85,
            }}
          >
            {/* The winner's flag. A century of the tournament is a century of
                these, which is the whole argument of the film. */}
            {winnerFlag ? (
              <div style={{width: u(2.6), height: u(1.73), flexShrink: 0}}>
                <Flag spec={winnerFlag} bordered={false} />
              </div>
            ) : null}
            <span>{entry.winner ?? '—'}</span>
          </div>
        </div>
      )}
    </div>
  );
};

/**
 * The hero freeze-frames. Rendered as high-contrast duotone linework, driven by
 * the same pose data as the nation modules — so, again, no real player is
 * depicted. Each action maps onto an existing pose track.
 */
const HERO_POSE: Record<string, {slot: keyof typeof players; at: number}> = {
  'first-whistle': {slot: 'spain', at: 0.12},
  volley: {slot: 'portugal', at: 0.62},
  header: {slot: 'paraguay', at: 0.42},
  'solo-run': {slot: 'argentina', at: 0.66},
  save: {slot: 'paraguay', at: 0.72},
  lift: {slot: 'uruguay', at: 0.1},
};

const HeroFreeze: React.FC<{entry: TimelineEntry; strength: number}> = ({entry, strength}) => {
  const {u, t, pick} = useLayout();
  if (!entry.hero) return null;
  const mapping = HERO_POSE[entry.hero.action] ?? {slot: 'argentina' as const, at: 0.5};
  const slot = players[mapping.slot]!;

  return (
    <AbsoluteFill
      style={{
        alignItems: 'center',
        justifyContent: 'center',
        opacity: strength,
        pointerEvents: 'none',
      }}
    >
      <div
        style={{
          position: 'relative',
          width: pick({landscape: '34%', portrait: '78%', square: '58%'}),
          height: pick({landscape: '62%', portrait: '38%', square: '50%'}),
          transform: `scale(${interpolate(strength, [0, 1], [0.92, 1])})`,
        }}
      >
        <PlayerSilhouette
          slot={slot}
          progress={mapping.at}
          linework
          showBall
          supporting={false}
          figureColor={palette.goldLight}
          markColor={palette.goldTrophy}
        />
      </div>
      <div
        style={{
          fontFamily: fontStacks.body,
          fontSize: t(typeScale.body),
          fontStyle: 'italic',
          letterSpacing: letterspacing.wide,
          color: palette.goldLight,
          marginTop: u(1),
          opacity: 0.9,
        }}
      >
        {entry.hero.label}
      </div>
    </AbsoluteFill>
  );
};

export const Timeline100: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const {u, t, pick} = useLayout();

  const heroIndices = useMemo(
    () => worldCups.map((c, i) => (c.hero ? i : -1)).filter((i) => i >= 0),
    [],
  );
  const rail = useMemo(
    () => buildRailCurve(heroIndices, worldCups.length),
    [heroIndices],
  );
  const travelled = rail[Math.min(frame, END)] ?? 0;

  // Motion blur follows velocity, not position.
  const velocity = (rail[Math.min(frame + 1, END)] ?? 0) - travelled;
  const blur = Math.max(0, (velocity - 0.32) * 5.5);

  // Which hero card, if any, is currently centred.
  const heroState = useMemo(() => {
    let best: {entry: TimelineEntry; strength: number} | null = null;
    for (const i of heroIndices) {
      const d = Math.abs(i - travelled);
      if (d < 0.5) {
        const strength = interpolate(d, [0.16, 0.5], [1, 0], {
          extrapolateLeft: 'clamp',
          extrapolateRight: 'clamp',
        });
        if (!best || strength > best.strength) {
          best = {entry: worldCups[i]!, strength};
        }
      }
    }
    return best;
  }, [heroIndices, travelled]);

  const slamSpring = spring({
    frame: frame - SLAM,
    fps,
    config: springs.slam,
    durationInFrames: 26,
  });

  const railFade = interpolate(frame, [SLAM - 4, SLAM + 8], [1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  return (
    <AbsoluteFill style={{backgroundColor: palette.ink, overflow: 'hidden'}}>
      <AbsoluteFill
        style={{
          background: `radial-gradient(ellipse at 50% 50%, ${palette.pitchDeep} 0%, ${palette.ink} 74%)`,
        }}
      />

      {/* ── The rail ─────────────────────────────────────────────────────── */}
      <AbsoluteFill style={{opacity: railFade}}>
        {/* The gold rail itself — the only continuous line in the film. */}
        <div
          style={{
            position: 'absolute',
            top: '50%',
            left: 0,
            right: 0,
            height: u(0.26),
            backgroundColor: palette.goldTrophy,
            opacity: 0.75,
          }}
        />

        {[0, 1].map((row) => (
          <div
            key={row}
            style={{
              position: 'absolute',
              top: row === 0 ? pick({landscape: '18%', portrait: '26%'}) : '56%',
              left: '50%',
              width: 0,
              height: pick({landscape: '28%', portrait: '20%'}),
              // Rows travel at slightly different rates — the parallax that
              // stops the century reading as one flat strip.
              transform: `translateX(${-travelled * u(STRIDE) * ROW_PARALLAX[row]!}px)`,
            }}
          >
            {worldCups
              .filter((_, i) => i % 2 === row)
              .map((entry) => {
                const index = worldCups.indexOf(entry);
                // Cull anything far off-frame; at 26 cards this matters for
                // render time across 420 frames.
                if (Math.abs(index - travelled) > 7) return null;
                return (
                  <YearCard
                    key={entry.year}
                    entry={entry}
                    offset={index}
                    distance={index - travelled}
                    row={row}
                    blur={blur}
                    parallax={ROW_PARALLAX[row]!}
                  />
                );
              })}
          </div>
        ))}

        {/* Tick marks on the rail, one per edition. */}
        <div
          style={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: `translateX(${-travelled * u(STRIDE)}px)`,
          }}
        >
          {worldCups.map((entry, i) =>
            Math.abs(i - travelled) > 8 ? null : (
              <div
                key={entry.year}
                style={{
                  position: 'absolute',
                  transform: `translateX(${i * u(STRIDE)}px)`,
                  width: u(0.3),
                  height: u(entry.hero ? 2.4 : 1.2),
                  marginTop: u(-0.6),
                  backgroundColor: entry.hero ? palette.goldTrophy : palette.bone,
                  opacity: entry.cancelled ? 0.3 : 0.8,
                }}
              />
            ),
          )}
        </div>
      </AbsoluteFill>

      {/* ── Hero freeze-frames ───────────────────────────────────────────── */}
      {heroState ? (
        <>
          <AbsoluteFill
            style={{
              background: `radial-gradient(ellipse at 50% 50%, rgba(5,11,8,0.96) 0%, rgba(5,11,8,0.78) 78%)`,
              opacity: heroState.strength,
            }}
          />
          <HeroFreeze entry={heroState.entry} strength={heroState.strength} />
          {/* Year and caption sit in a left column, clear of the figure and
              clear of the rail card that triggered the hold. */}
          <AbsoluteFill
            style={{
              alignItems: 'flex-start',
              justifyContent: 'center',
              flexDirection: 'column',
              gap: u(1.2),
              padding: `0 ${u(9)}px`,
              opacity: heroState.strength,
            }}
          >
            <div
              style={{
                fontFamily: fontStacks.display,
                fontSize: t(typeScale.hero * 0.72),
                lineHeight: 0.9,
                color: palette.goldTrophy,
                fontVariantNumeric: 'tabular-nums',
                letterSpacing: letterspacing.tight,
              }}
            >
              {heroState.entry.year}
            </div>
            <div
              style={{
                width: u(10) * heroState.strength,
                height: u(0.22),
                backgroundColor: palette.goldTrophy,
              }}
            />
            <div
              style={{
                fontFamily: fontStacks.body,
                fontSize: t(typeScale.caption),
                fontWeight: 500,
                textTransform: 'uppercase',
                letterSpacing: letterspacing.ultra,
                color: palette.bone,
                opacity: 0.8,
                maxWidth: '34%',
                lineHeight: 1.5,
              }}
            >
              {heroState.entry.host}
              {heroState.entry.winner ? ` · ★ ${heroState.entry.winner}` : ''}
            </div>
          </AbsoluteFill>
        </>
      ) : null}

      {/* ── The slam onto 2030 ───────────────────────────────────────────── */}
      {frame >= SLAM - 6 ? (
        <AbsoluteFill
          style={{
            alignItems: 'center',
            justifyContent: 'center',
            flexDirection: 'column',
            gap: u(1.6),
            padding: `${u(4)}px ${u(8)}px`,
          }}
        >
          <div
            style={{
              fontFamily: fontStacks.display,
              fontSize: t(typeScale.hero),
              lineHeight: 0.94,
              color: palette.goldTrophy,
              fontVariantNumeric: 'tabular-nums',
              letterSpacing: letterspacing.tight,
              transform: `scale(${interpolate(slamSpring, [0, 1], [1.35, 1])})`,
              opacity: interpolate(slamSpring, [0, 0.2, 1], [0, 1, 1]),
              textShadow: `0 ${u(0.3)}px ${u(2.4)}px rgba(212,167,60,0.35)`,
            }}
          >
            {CENTENARY.year}
          </div>
          <div style={{marginTop: u(0.6)}}>
            <TypeLine
              delay={SLAM + 10}
              size={typeScale.title}
              tracking="ultra"
              color={palette.bone}
              mode="track-in"
            >
              100 Years
            </TypeLine>
          </div>
          <div
            style={{
              fontFamily: fontStacks.body,
              fontSize: t(typeScale.caption),
              fontWeight: 500,
              letterSpacing: letterspacing.ultra,
              textTransform: 'uppercase',
              color: palette.bone,
              opacity: interpolate(frame, [SLAM + 22, SLAM + 34], [0, 0.7], {
                extrapolateLeft: 'clamp',
                extrapolateRight: 'clamp',
              }),
              textAlign: 'center',
            }}
          >
            1930 — 2030
          </div>
        </AbsoluteFill>
      ) : null}

      <Shockwave triggerFrame={SLAM} maxRadius={72} duration={40} />
      <GoldParticles triggerFrame={SLAM} count={120} spread={52} lifetime={60} gravity={0.22} />
    </AbsoluteFill>
  );
};
