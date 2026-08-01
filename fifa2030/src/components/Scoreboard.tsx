import {interpolate, spring, useCurrentFrame, useVideoConfig} from 'remotion';
import {useLayout} from '../config/layout';
import {flagByCode, WINNER_FLAG, type FlagSpec} from '../config/flags';
import {fontStacks, letterspacing, palette, springs, typeScale} from '../config/theme';
import type {TimelineEntry} from '../config/timeline';
import {Flag} from './Flag';

/**
 * A broadcast final scoreboard.
 *
 * This is the detail that turns the timeline from a list of years into a
 * hundred years of football: every one of these was ninety minutes somebody
 * still remembers. Modelled on a live match bug — flag, name, score, flag —
 * with the extra-time and shoot-out tags a real one carries.
 *
 * The two halves build outward from the score, which is how a scoreboard
 * resolves on air: the number lands first and the teams arrive around it.
 */
export const Scoreboard: React.FC<{
  entry: TimelineEntry;
  /** Frame the board starts on, relative to the enclosing Sequence. */
  delay?: number;
  /** 0 → 1 master visibility. */
  strength?: number;
  compact?: boolean;
}> = ({entry, delay = 0, strength = 1, compact = false}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const {u, t} = useLayout();

  const final = entry.final;
  if (!final || !entry.winner) return null;

  const winnerFlag = flagByCode(WINNER_FLAG[entry.winner] ?? '');
  const runnerFlag = flagByCode(WINNER_FLAG[final.runnerUp] ?? '');

  const local = frame - delay;
  const core = spring({frame: local, fps, config: springs.slam, durationInFrames: 22});
  const wings = spring({frame: local - 6, fps, config: springs.settle, durationInFrames: 28});

  const flagW = compact ? u(3.4) : u(5.2);

  const Side: React.FC<{
    flag: FlagSpec | undefined;
    name: string;
    goals: string;
    champion: boolean;
    align: 'left' | 'right';
  }> = ({flag, name, goals, champion, align}) => (
    <div
      style={{
        display: 'flex',
        flexDirection: align === 'left' ? 'row' : 'row-reverse',
        alignItems: 'center',
        gap: u(1.2),
        opacity: wings,
        transform: `translateX(${interpolate(wings, [0, 1], [align === 'left' ? u(3) : -u(3), 0])}px)`,
        flex: 1,
        justifyContent: 'flex-end',
      }}
    >
      <span
        style={{
          fontFamily: fontStacks.display,
          fontSize: t(compact ? typeScale.subtitle * 0.8 : typeScale.subtitle),
          textTransform: 'uppercase',
          letterSpacing: letterspacing.tight,
          // The champion is bone and full weight; the runner-up is dimmed.
          color: champion ? palette.bone : palette.bone,
          opacity: champion ? 1 : 0.55,
          whiteSpace: 'nowrap',
        }}
      >
        {name}
      </span>
      {flag ? (
        <div style={{width: flagW, height: flagW * (2 / 3), flexShrink: 0, opacity: champion ? 1 : 0.6}}>
          <Flag spec={flag} bordered={false} />
        </div>
      ) : null}
      <span
        style={{
          fontFamily: fontStacks.display,
          fontSize: t(compact ? typeScale.subtitle : typeScale.title),
          color: champion ? palette.goldTrophy : palette.bone,
          opacity: champion ? 1 : 0.6,
          fontVariantNumeric: 'tabular-nums',
          fontFeatureSettings: '"tnum" 1',
          minWidth: t(compact ? typeScale.subtitle : typeScale.title) * 0.72,
          textAlign: 'center',
        }}
      >
        {goals}
      </span>
    </div>
  );

  const [homeGoals, awayGoals] = final.score.split('-');

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: u(0.8),
        opacity: strength,
        width: '100%',
      }}
    >
      {/* Header rail — the year and the fixture. */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: u(1.2),
          opacity: core * 0.85,
        }}
      >
        <div style={{width: u(2.4) * core, height: u(0.16), backgroundColor: palette.goldTrophy}} />
        <span
          style={{
            fontFamily: fontStacks.body,
            fontSize: t(typeScale.micro),
            fontWeight: 600,
            letterSpacing: letterspacing.ultra,
            textTransform: 'uppercase',
            color: palette.goldLight,
            whiteSpace: 'nowrap',
          }}
        >
          {entry.year} Final
        </span>
        <div style={{width: u(2.4) * core, height: u(0.16), backgroundColor: palette.goldTrophy}} />
      </div>

      {/* The board. */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: u(1.6),
          padding: `${u(1.1)}px ${u(2.2)}px`,
          borderRadius: u(0.6),
          backgroundColor: 'rgba(5,11,8,0.72)',
          border: `${u(0.12)}px solid rgba(212,167,60,${0.45 * core})`,
          transform: `scaleY(${interpolate(core, [0, 1], [0.4, 1])})`,
          maxWidth: '92%',
        }}
      >
        <Side
          flag={winnerFlag}
          name={entry.winner}
          goals={homeGoals ?? '0'}
          champion
          align="left"
        />
        <span
          style={{
            fontFamily: fontStacks.display,
            fontSize: t(compact ? typeScale.subtitle : typeScale.title),
            color: palette.goldTrophy,
            opacity: 0.5,
          }}
        >
          –
        </span>
        <Side
          flag={runnerFlag}
          name={final.runnerUp}
          goals={awayGoals ?? '0'}
          champion={false}
          align="right"
        />
      </div>

      {/* Extra time, shoot-out, venue — the footnotes a real board carries. */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: u(1.4),
          opacity: interpolate(local, [16, 28], [0, 0.72], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
          }),
          flexWrap: 'wrap',
          justifyContent: 'center',
        }}
      >
        {final.decider ? (
          <span
            style={{
              fontFamily: fontStacks.body,
              fontSize: t(typeScale.micro),
              fontWeight: 700,
              letterSpacing: letterspacing.wide,
              color: palette.ink,
              backgroundColor: palette.goldTrophy,
              padding: `${u(0.2)}px ${u(0.7)}px`,
              borderRadius: u(0.25),
            }}
          >
            {final.decider === 'pens' ? `PENS ${final.pens}` : 'AET'}
          </span>
        ) : null}
        {final.venue && !compact ? (
          <span
            style={{
              fontFamily: fontStacks.body,
              fontSize: t(typeScale.micro),
              fontWeight: 500,
              letterSpacing: letterspacing.wide,
              textTransform: 'uppercase',
              color: palette.bone,
              opacity: 0.7,
            }}
          >
            {final.venue}
          </span>
        ) : null}
      </div>
    </div>
  );
};
