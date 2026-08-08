/**
 * Clap + wake-phrase detector — Phase 4.
 *
 * "I clap and say <phrase>, JARVIS wakes up." Runs entirely in the
 * browser tab, on the user's own microphone (never sent anywhere):
 *
 *   1. Continuously watch the mic's volume for a clap-like transient
 *      (a sudden loud spike well above the recent ambient noise floor).
 *   2. On a clap, arm a short listening window and use the Web Speech
 *      API to check whether the configured wake phrase was said.
 *   3. If it matches, fire `onWake()`. If the window times out with no
 *      match, go back to watching for the next clap.
 *
 * This is a volume-transient heuristic, not real clap classification —
 * any sufficiently sharp, loud sound (a real clap, a door, a dropped
 * book) can trigger the arm window. That's an acceptable false-positive
 * rate for a personal desktop assistant; it only *wakes* on a clap
 * followed by the correct phrase.
 *
 * Privacy: nothing is recorded or sent anywhere. The mic is only ever
 * active while `start()` has been called (an explicit, visible user
 * action — see the UI's mic indicator), and `stop()` releases the
 * microphone track entirely.
 */
import { listenWithinWindow } from "./voice";

export type WakeWordStatus = "stopped" | "monitoring" | "armed" | "error";

export interface WakeWordOptions {
  phrase: string;
  onWake: () => void;
  onStatusChange?: (status: WakeWordStatus, detail?: string) => void;
  armWindowMs?: number;
}

const CLAP_MULTIPLIER = 2.8;
const CLAP_ABS_MIN = 0.12;
const CLAP_DELTA_MIN = 0.08;
const COOLDOWN_MS = 1800;
const NOISE_FLOOR_EMA_ALPHA = 0.05;

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function phraseMatches(transcript: string, phrase: string): boolean {
  return normalize(transcript).includes(normalize(phrase));
}

export class WakeWordDetector {
  private stream: MediaStream | null = null;
  private audioCtx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private rafId: number | null = null;
  private buffer: Uint8Array | null = null;

  private noiseFloor = 0.02;
  private lastRms = 0;
  private lastClapAt = 0;
  private armed = false;
  private stopPhraseListener: (() => void) | null = null;
  private armTimer: number | null = null;

  private readonly opts: Required<Omit<WakeWordOptions, "onStatusChange">> &
    Pick<WakeWordOptions, "onStatusChange">;

  constructor(opts: WakeWordOptions) {
    this.opts = { armWindowMs: 4000, ...opts };
  }

  get isRunning(): boolean {
    return this.stream !== null;
  }

  async start(): Promise<void> {
    if (this.stream) return;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      this.emit("error", err instanceof Error ? err.message : "Microphone access denied.");
      throw err;
    }

    const AudioCtx = window.AudioContext ?? (window as any).webkitAudioContext;
    this.audioCtx = new AudioCtx();
    const source = this.audioCtx.createMediaStreamSource(this.stream);
    this.analyser = this.audioCtx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.buffer = new Uint8Array(this.analyser.frequencyBinCount);
    source.connect(this.analyser);

    this.emit("monitoring");
    this.tick();
  }

  stop(): void {
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    if (this.armTimer !== null) window.clearTimeout(this.armTimer);
    this.stopPhraseListener?.();
    this.stream?.getTracks().forEach((track) => track.stop());
    this.audioCtx?.close().catch(() => {});
    this.stream = null;
    this.audioCtx = null;
    this.analyser = null;
    this.armed = false;
    this.emit("stopped");
  }

  private emit(status: WakeWordStatus, detail?: string) {
    this.opts.onStatusChange?.(status, detail);
  }

  private tick = () => {
    if (!this.analyser || !this.buffer) return;
    this.analyser.getByteTimeDomainData(this.buffer as Uint8Array<ArrayBuffer>);

    let sumSquares = 0;
    for (let i = 0; i < this.buffer.length; i++) {
      const normalized = (this.buffer[i] - 128) / 128;
      sumSquares += normalized * normalized;
    }
    const rms = Math.sqrt(sumSquares / this.buffer.length);

    const now = performance.now();
    if (!this.armed) {
      const delta = rms - this.lastRms;
      const isClap =
        rms > Math.max(this.noiseFloor * CLAP_MULTIPLIER, CLAP_ABS_MIN) &&
        delta > CLAP_DELTA_MIN &&
        now - this.lastClapAt > COOLDOWN_MS;

      if (isClap) {
        this.lastClapAt = now;
        this.armForPhrase();
      } else {
        // Slowly adapt to ambient noise so a quiet room and a noisy room
        // both work without hand-tuned thresholds.
        this.noiseFloor = this.noiseFloor * (1 - NOISE_FLOOR_EMA_ALPHA) + rms * NOISE_FLOOR_EMA_ALPHA;
      }
    }
    this.lastRms = rms;

    this.rafId = requestAnimationFrame(this.tick);
  };

  private armForPhrase() {
    this.armed = true;
    this.emit("armed");

    this.stopPhraseListener = listenWithinWindow(this.opts.armWindowMs, (transcript) => {
      if (!this.armed) return;
      if (phraseMatches(transcript, this.opts.phrase)) {
        this.disarm();
        this.opts.onWake();
      }
    });

    this.armTimer = window.setTimeout(() => {
      if (this.armed) this.disarm();
    }, this.opts.armWindowMs + 100);
  }

  private disarm() {
    this.armed = false;
    this.stopPhraseListener?.();
    this.stopPhraseListener = null;
    if (this.armTimer !== null) {
      window.clearTimeout(this.armTimer);
      this.armTimer = null;
    }
    if (this.stream) this.emit("monitoring");
  }
}
