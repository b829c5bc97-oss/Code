import {Composition} from 'remotion';
import {FIFA2030Intro} from './FIFA2030Intro';
import {FPS, TOTAL_FRAMES} from './config/theme';

/**
 * Three deliverables from one component tree. Nothing in the film is
 * positioned in absolute pixels, so the same scenes recompose for each frame
 * shape (see `src/config/layout.ts`).
 */
export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="FIFA2030Intro"
        component={FIFA2030Intro}
        durationInFrames={TOTAL_FRAMES}
        fps={FPS}
        width={1920}
        height={1080}
      />
      <Composition
        id="FIFA2030Intro-Vertical"
        component={FIFA2030Intro}
        durationInFrames={TOTAL_FRAMES}
        fps={FPS}
        width={1080}
        height={1920}
      />
      <Composition
        id="FIFA2030Intro-Square"
        component={FIFA2030Intro}
        durationInFrames={TOTAL_FRAMES}
        fps={FPS}
        width={1080}
        height={1080}
      />
    </>
  );
};
