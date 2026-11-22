import { analyzeBass, type BassAnalysis, type BassInput } from './bass';
import { mixDown } from './mixDown';

/** Analysis rate: ~2.75 kHz Nyquist comfortably covers bass fundamentals and low harmonics. */
const TARGET_RATE = 5512;

/**
 * Transcribes the already-decoded bass stem into 5-string tablature in a Web Worker. The stem is
 * mixed to one decimated mono signal and transferred, not copied.
 */
export async function detectBass(
  bass: AudioBuffer,
  beats: number[],
  downbeat: number,
  duration: number,
  meter: 3 | 4,
  division: 3 | 4,
  swing: boolean,
): Promise<BassAnalysis> {
  const prepare = (): BassInput => {
    const { samples, sampleRate } = mixDown([bass], TARGET_RATE);
    return { samples, sampleRate, beats, downbeat, meter, division, swing, duration };
  };
  try {
    return await runInWorker(prepare());
  } catch {
    // Workers unavailable (or failed) — the first array was transferred (detached), so make a new one.
    return analyzeBass(prepare());
  }
}

function runInWorker(input: BassInput): Promise<BassAnalysis> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./bass.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<{ ok: boolean; result?: BassAnalysis; error?: string }>) => {
      worker.terminate();
      if (e.data.ok) resolve(e.data.result!);
      else reject(new Error(e.data.error));
    };
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(e.message));
    };
    worker.postMessage(input, [input.samples.buffer as ArrayBuffer]);
  });
}
