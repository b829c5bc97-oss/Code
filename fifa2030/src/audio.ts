import {useAudioData, visualizeAudio} from '@remotion/media-utils';
import {staticFile, useVideoConfig} from 'remotion';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  SCORE — and the two places picture is genuinely locked to it
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `public/audio/temp-score.mp3` is a SCRATCH TRACK, synthesised by
 * `tools/make-temp-score.mjs` to the structure in the brief so that the cut,
 * the beat grid and the audio-reactive elements have real amplitude data to
 * work against.
 *
 * SWAP POINT: drop the licensed score in at the same path and re-render.
 * Nothing else needs to change as long as it is 90.0s at 120 BPM. If the final
 * score runs at a different tempo, change `BPM` in `config/theme.ts` — the beat
 * grid, the cut points and the hexagon wipes all derive from it.
 *
 * Two elements read the waveform rather than approximating it:
 *   · the crowd wave intensity in Shot 11 (`useScoreAmplitude`)
 *   · the gold particle burst scale in Shot 01 (`useScoreAmplitude`)
 */

export const SCORE_SRC = staticFile('audio/temp-score.mp3');

/** Number of frequency bins sampled. Power of two, as visualizeAudio requires. */
const BINS = 32;

/**
 * Normalised low-frequency energy of the score at an ABSOLUTE film frame,
 * 0 → ~1. Returns a neutral 0.5 while the audio is still loading so a scene
 * never pops when the data arrives mid-render.
 */
export const useScoreAmplitude = (absoluteFrame: number): number => {
  const {fps} = useVideoConfig();
  const audioData = useAudioData(SCORE_SRC);

  if (!audioData) return 0.5;

  const spectrum = visualizeAudio({
    audioData,
    frame: absoluteFrame,
    fps,
    numberOfSamples: BINS,
  });

  // Low bins carry the kick and the orchestral body — what a crowd actually
  // moves to. Averaging the whole spectrum would let cymbals drive the wave.
  const low = spectrum.slice(0, 8);
  const energy = low.reduce((a, b) => a + b, 0) / low.length;

  return Math.min(1, energy * 4.2);
};
