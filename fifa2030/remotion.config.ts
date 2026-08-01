import {Config} from '@remotion/cli/config';
import fs from 'node:fs';

Config.setVideoImageFormat('jpeg');
Config.setCodec('h264');
Config.setCrf(16);
Config.setPixelFormat('yuv420p');
Config.setOverwriteOutput(true);
Config.setChromiumOpenGlRenderer('angle-egl');

// This container ships a Chromium/headless-shell build. Reuse it instead of
// making Remotion download its own, and fall back to Remotion's default when
// the binary isn't present (e.g. a normal developer machine).
const localChromiumCandidates = [
  process.env.REMOTION_BROWSER_EXECUTABLE,
  '/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell',
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
].filter(Boolean) as string[];

const localChromium = localChromiumCandidates.find((p) => fs.existsSync(p));
if (localChromium) {
  Config.setBrowserExecutable(localChromium);
}
