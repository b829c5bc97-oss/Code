import {AbsoluteFill, Audio, Series} from 'remotion';
import {SCORE_SRC} from './audio';
import {loadFonts} from './fonts';
import {FilmGrade, GrainOverlay} from './components/GrainOverlay';
import {nations} from './config/nations';
import {palette} from './config/theme';
import {Timeline100} from './scenes/03-Timeline100';
import {GlobeScene} from './scenes/04-Globe';
import {NationModule} from './scenes/05-NationModule';
import {StadiumScene} from './scenes/11-Stadium';
import {UnityLockup} from './scenes/12-UnityLockup';

loadFonts();

/**
 * Placeholder for shots still in production. Holds correct timing and a
 * neutral graded frame so the master render never contains a blank or a
 * broken import while the sequence is being built out.
 */
const Slate: React.FC<{label: string}> = ({label}) => (
  <AbsoluteFill
    style={{
      backgroundColor: palette.pitchDeep,
      alignItems: 'center',
      justifyContent: 'center',
      color: palette.bone,
      fontFamily: 'monospace',
      fontSize: '2.4vmin',
      letterSpacing: '0.3em',
      opacity: 0.35,
    }}
  >
    {label}
  </AbsoluteFill>
);

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  FIFA WORLD CUP 2030 — CENTENARY TITLE SEQUENCE
 *  90 seconds · 2700 frames · 30fps · 120 BPM (one beat every 15 frames)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  ORIGIN  → 1930, Montevideo. Where the World Cup began.
 *  JOURNEY → 100 years, six nations, three continents.
 *  UNITY   → One stadium, one crowd, one game.
 */
export const FIFA2030Intro: React.FC = () => {
  return (
    <AbsoluteFill style={{backgroundColor: palette.ink}}>
      {/* The temp score. See src/audio.ts for the licensed-score swap. */}
      <Audio src={SCORE_SRC} />

      <Series>
        {/* ORIGIN ─────────────────────────────────────────────────────── */}
        <Series.Sequence durationInFrames={180} name="01 · First Touch">
          <Slate label="SHOT 01 — FIRST TOUCH" />
        </Series.Sequence>

        <Series.Sequence durationInFrames={240} name="02 · Estadio Centenario 1930">
          <Slate label="SHOT 02 — CENTENARIO 1930" />
        </Series.Sequence>

        {/* JOURNEY ────────────────────────────────────────────────────── */}
        <Series.Sequence durationInFrames={420} name="03 · 100 Years">
          <Timeline100 />
        </Series.Sequence>

        <Series.Sequence durationInFrames={240} name="04 · Three Continents">
          <GlobeScene />
        </Series.Sequence>

        {nations.map((nation, i) => (
          <Series.Sequence
            key={nation.id}
            durationInFrames={180}
            name={`${String(5 + i).padStart(2, '0')} · ${nation.nameEn}`}
          >
            <NationModule nation={nation} />
          </Series.Sequence>
        ))}

        {/* UNITY ──────────────────────────────────────────────────────── */}
        <Series.Sequence durationInFrames={360} name="11 · The Stadium">
          <StadiumScene />
        </Series.Sequence>

        <Series.Sequence durationInFrames={180} name="12 · Unity Lockup">
          <UnityLockup />
        </Series.Sequence>
      </Series>

      {/* Grade and grain sit above every shot so the film reads as one piece
          of stock rather than twelve separately-treated scenes. */}
      <FilmGrade />
      <GrainOverlay />
    </AbsoluteFill>
  );
};
