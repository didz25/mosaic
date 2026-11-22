/**
 * 5-string bass tablature transcription (standard B–E–A–D–G tuning).
 *
 * 1. Conditioning: 25 Hz high-pass + 900 Hz two-pole low-pass for pitch tracking; 140 Hz high-pass
 *    for pluck/attack detection.
 * 2. Pitch tracking: FFT-accelerated YIN (CMNDF) per 10 ms frame over 28–340 Hz (B0 = 30.87 Hz to
 *    E4 = 329.6 Hz), with subharmonic guards at tau/2 and tau/3 to avoid octave-down errors on
 *    pure tones without suppressing weak-fundamental bass tones.
 * 3. Smoothing: 42-state Viterbi (MIDI 23..63 + UNVOICED) with onset-aware transition penalties.
 * 4. Event-first + metrical quantization: discrete note events are segmented from smoothed
 *    frame MIDI + NMS onset peaks, then snapped to the tracked grid via metrical-prior Viterbi DP.
 * 5. 5-string fingering: hand-position Viterbi DP assigns playable (string, fret, handPos)
 *    coordinates on B–E–A–D–G, staying in 4-fret boxes, keeping position across open strings,
 *    and minimizing shifts.
 * 6. Riff map: bars cluster into repeating riffs (𝄎), fills, and rests.
 *
 * Pure function of the samples so it can be unit-tested with synthetic bass audio.
 */

import { FFT } from './chords';

/** 5-string standard bass strings in top-to-bottom tablature order. */
export const BASS_STRINGS = ['G', 'D', 'A', 'E', 'B'] as const;
/** Open string MIDI note numbers matching BASS_STRINGS: G2=43, D2=38, A1=33, E1=28, B0=23. */
export const BASS_TUNING = [43, 38, 33, 28, 23] as const;
export type BassStringCount = 4 | 5;
export const BASS_MIN_MIDI = 23;
export const BASS_MAX_MIDI = 63;
export const BASS_MAX_FRET = 20;

export function bassStrings(count: BassStringCount): readonly string[] {
  return count === 4 ? BASS_STRINGS.slice(0, 4) : BASS_STRINGS;
}

export function bassTuning(count: BassStringCount): readonly number[] {
  return count === 4 ? BASS_TUNING.slice(0, 4) : BASS_TUNING;
}

export interface BassNote {
  /** Step index within the bar (0 .. meter * division - 1). */
  step: number;
  /** MIDI note number (23 = B0 .. 63 = D#4). */
  midi: number;
  /** String index in BASS_STRINGS order: 0 = G, 1 = D, 2 = A, 3 = E, 4 = B. */
  string: number;
  /** Fret number (0 .. 20). */
  fret: number;
  /** Note length in steps (1 .. remaining steps in the bar). */
  duration: number;
  /** Velocity 0.4 .. 1. */
  velocity: number;
}

export interface BassBar {
  start: number;
  end: number;
  /** Start time of each beat in the bar (`meter` entries; pickup beats may be extrapolated). */
  beats: number[];
  kind: 'riff' | 'fill' | 'rest';
  /** Riff index (0, 1, … in order of first appearance); -1 for fills and rests. */
  riff: number;
  /** Same riff as the bar right before it: shown as a repeat sign. */
  repeat: boolean;
  notes: BassNote[];
}

export interface BassAnalysis {
  meter: 3 | 4;
  /** Steps per beat: 4 (sixteenths) when straight, 3 (triplets) when swung. */
  division: 3 | 4;
  swing: boolean;
  bars: BassBar[];
}

export interface BassInput {
  /** Mono bass stem samples. */
  samples: Float32Array;
  sampleRate: number;
  /** Beat times in seconds of track time. */
  beats: number[];
  /** Index into `beats` of the first downbeat. */
  downbeat: number;
  meter?: 3 | 4;
  division?: 3 | 4;
  swing?: boolean;
  duration: number;
}

export interface BassSection {
  kind: BassBar['kind'];
  riff: number;
  first: number;
  count: number;
  start: number;
  end: number;
  notes: BassNote[];
  steps: number;
}

const TARGET_FPS = 100;
const UNVOICED = BASS_MAX_MIDI - BASS_MIN_MIDI + 1;
const STATES = UNVOICED + 1;
const MIN_FREQ = 28;
const MAX_FREQ = 340;
const CMNDF_MAX = 0.42;

export function analyzeBass({ samples, sampleRate, beats, downbeat, meter = 4, division = 4, swing = false, duration }: BassInput): BassAnalysis {
  if (beats.length < 2 || samples.length < 64) return { meter, division, swing, bars: [] };

  const hop = Math.max(1, Math.round(sampleRate / TARGET_FPS));
  // Exact frame rate: rounding the hop would otherwise stretch the timeline.
  const fps = sampleRate / hop;
  const frames = Math.max(1, Math.ceil(samples.length / hop));

  const { lp, pluck } = conditionSignal(samples, sampleRate);
  const cumSq = prefixSquares(lp);
  const cumHiSq = prefixSquares(pluck);

  const rmsWin = Math.max(1, Math.round(sampleRate * 0.025));
  const halfRms = rmsWin >> 1;
  const hiWin = Math.max(1, Math.round(sampleRate * 0.02));
  const halfHi = hiWin >> 1;

  const rms = new Float32Array(frames);
  const hiRms = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    const c = f * hop;
    const r0 = Math.max(0, c - halfRms);
    const r1 = Math.min(lp.length, r0 + rmsWin);
    rms[f] = Math.sqrt((cumSq[r1] - cumSq[r0]) / Math.max(1, r1 - r0));
    const h0 = Math.max(0, c - halfHi);
    const h1 = Math.min(pluck.length, h0 + hiWin);
    hiRms[f] = Math.sqrt((cumHiSq[h1] - cumHiSq[h0]) / Math.max(1, h1 - h0));
  }

  const positiveRms = Array.from(rms).filter((v) => v > 0);
  const refRms = percentile(positiveRms, 0.9);
  const positiveHi = Array.from(hiRms).filter((v) => v > 0);
  const refHi = percentile(positiveHi, 0.9);
  const barWindows = buildBarWindows(beats, downbeat, meter, duration);
  if (refRms < 1e-4) {
    return {
      meter,
      division,
      swing,
      bars: barWindows.map((w) => ({
        start: round(Math.max(0, w.start), 1000),
        end: round(Math.min(duration, w.end), 1000),
        beats: w.beats.map((t) => round(t, 1000)),
        kind: 'rest',
        riff: -1,
        repeat: false,
        notes: [],
      })),
    };
  }

  const onset = onsetEnvelope(rms, hiRms, refRms, refHi);
  const emissions = yinEmissions(lp, cumSq, rms, refRms, sampleRate, hop, frames);
  const frameMidi = viterbiPitch(emissions, onset);

  const bars = extractBarNotes(barWindows, frameMidi, rms, onset, refRms, fps, division, duration);
  const assigned = assignBassFingering(bars, 0, 5, division);
  labelBassBars(assigned, division);
  return { meter, division, swing, bars: assigned };
}

// ---------- signal conditioning & envelopes ----------

function conditionSignal(samples: Float32Array, sampleRate: number) {
  const n = samples.length;
  const lp = new Float32Array(n);
  const pluck = new Float32Array(n);

  const aHp = Math.exp((-2 * Math.PI * 25) / sampleRate);
  const aLp = 1 - Math.exp((-2 * Math.PI * 900) / sampleRate);
  const aPluck = Math.exp((-2 * Math.PI * 140) / sampleRate);

  let hp = 0;
  let prevHpX = 0;
  let lp1 = 0;
  let lp2 = 0;
  let pl = 0;
  let prevPlX = 0;

  for (let i = 0; i < n; i++) {
    const x = samples[i];
    hp = aHp * (hp + x - prevHpX);
    prevHpX = x;
    lp1 += aLp * (hp - lp1);
    lp2 += aLp * (lp1 - lp2);
    lp[i] = lp2;

    pl = aPluck * (pl + x - prevPlX);
    prevPlX = x;
    pluck[i] = pl;
  }
  return { lp, pluck };
}

function prefixSquares(x: Float32Array): Float64Array {
  const out = new Float64Array(x.length + 1);
  for (let i = 0; i < x.length; i++) {
    const v = x[i];
    out[i + 1] = out[i] + v * v;
  }
  return out;
}

function onsetEnvelope(rms: Float32Array, hiRms: Float32Array, refRms: number, refHi: number): Float32Array {
  const n = rms.length;
  const floorR = Math.max(1e-5, 0.04 * refRms);
  const floorH = Math.max(1e-5, 0.04 * refHi);
  const logR = new Float32Array(n);
  const logH = new Float32Array(n);
  for (let f = 0; f < n; f++) {
    logR[f] = Math.log(floorR + rms[f]);
    logH[f] = Math.log(floorH + hiRms[f]);
  }
  const raw = new Float32Array(n);
  for (let f = 1; f < n; f++) {
    let minR = logR[f - 1];
    let minH = logH[f - 1];
    for (let d = 2; d <= 3 && f - d >= 0; d++) {
      if (logR[f - d] < minR) minR = logR[f - d];
      if (logH[f - d] < minH) minH = logH[f - d];
    }
    raw[f] = Math.max(0, logR[f] - minR) + 0.7 * Math.max(0, logH[f] - minH);
  }
  // Normalize by typical local onset peaks (clamped so sparse silence->note jumps can't skew it).
  const peaks: number[] = [];
  for (let f = 1; f + 1 < n; f++) {
    if (raw[f] > 0.2 && raw[f] >= raw[f - 1] && raw[f] >= raw[f + 1]) peaks.push(raw[f]);
  }
  const norm = Math.max(1.2, Math.min(3.0, percentile(peaks, 0.75) || 1.8));
  const onset = new Float32Array(n);
  for (let f = 0; f < n; f++) onset[f] = raw[f] / norm;
  return onset;
}

// ---------- FFT-accelerated YIN ----------

function yinEmissions(
  lp: Float32Array,
  cumSq: Float64Array,
  rms: Float32Array,
  refRms: number,
  sampleRate: number,
  hop: number,
  frames: number,
): Float64Array[] {
  const desiredW = Math.round(sampleRate * 0.056);
  const tauMin = Math.max(2, Math.floor(sampleRate / MAX_FREQ));
  const tauMax = Math.min(Math.ceil(sampleRate / MIN_FREQ), Math.max(tauMin + 2, Math.floor(lp.length / 2)));
  const W = Math.min(desiredW, Math.max(32, lp.length - tauMin - 4));

  let fftSize = 64;
  while (fftSize < W + tauMax) fftSize <<= 1;
  const half = fftSize >> 1;
  const fft = new FFT(fftSize);

  const re = new Float64Array(fftSize);
  const im = new Float64Array(fftSize);
  const cre = new Float64Array(fftSize);
  const cim = new Float64Array(fftSize);
  const cmndf = new Float64Array(tauMax + 2);

  const emissions: Float64Array[] = [];
  for (let f = 0; f < frames; f++) {
    const em = new Float64Array(STATES).fill(-0.5);
    em[UNVOICED] = 0.24;
    emissions.push(em);

    if (rms[f] < 0.05 * refRms || lp.length <= W + tauMin + 2) continue;

    const t = Math.max(0, Math.min(lp.length - W - 1, f * hop - (W >> 1)));
    const endA = Math.min(W, lp.length - t);
    const maxTau = Math.min(tauMax, lp.length - t - endA);
    if (maxTau <= tauMin + 1) continue;
    const endB = Math.min(endA + maxTau, lp.length - t);

    re.fill(0);
    im.fill(0);
    for (let i = 0; i < endA; i++) re[i] = lp[t + i];
    for (let i = 0; i < endB; i++) im[i] = lp[t + i];
    fft.transform(re, im);

    cre[0] = re[0] * im[0];
    cim[0] = 0;
    cre[half] = re[half] * im[half];
    cim[half] = 0;
    for (let k = 1; k < half; k++) {
      const nk = fftSize - k;
      const ar = 0.5 * (re[k] + re[nk]);
      const ai = 0.5 * (im[k] - im[nk]);
      const br = 0.5 * (im[k] + im[nk]);
      const bi = 0.5 * (re[nk] - re[k]);
      const pr = ar * br + ai * bi;
      const pi = ai * br - ar * bi;
      cre[k] = pr;
      cim[k] = pi;
      cre[nk] = pr;
      cim[nk] = -pi;
    }
    fft.transform(cre, cim);

    const eA = cumSq[t + endA] - cumSq[t];
    cmndf[0] = 1;
    let runningSum = 0;
    for (let tau = 1; tau <= maxTau; tau++) {
      const eB = cumSq[Math.min(lp.length, t + tau + endA)] - cumSq[Math.min(lp.length, t + tau)];
      const corr = cre[tau] / fftSize;
      const d = Math.max(0, eA + eB - 2 * corr);
      runningSum += d;
      cmndf[tau] = runningSum > 0 ? (d * tau) / runningSum : 1;
    }

    for (let tau = tauMin; tau < maxTau; tau++) {
      const v = cmndf[tau];
      if (v >= CMNDF_MAX || v > cmndf[tau - 1] || v > cmndf[tau + 1]) continue;

      const denom = cmndf[tau - 1] - 2 * v + cmndf[tau + 1];
      const delta = denom !== 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (cmndf[tau - 1] - cmndf[tau + 1])) / denom)) : 0;
      const tauHat = tau + delta;
      if (tauHat <= 0) continue;

      let clarity = Math.max(0, 1 - v);
      // Subharmonic guard: penalize period multiples (2*T0, 3*T0) whose half/third period dips just as low.
      const halfLag = Math.round(tau / 2);
      if (halfLag >= tauMin) {
        let minHalf = Infinity;
        for (let k = Math.max(tauMin, halfLag - 2); k <= Math.min(maxTau, halfLag + 2); k++) {
          if (cmndf[k] < minHalf) minHalf = cmndf[k];
        }
        if (minHalf <= v + 0.035) clarity *= 0.55;
      }
      const thirdLag = Math.round(tau / 3);
      if (thirdLag >= tauMin) {
        let minThird = Infinity;
        for (let k = Math.max(tauMin, thirdLag - 2); k <= Math.min(maxTau, thirdLag + 2); k++) {
          if (cmndf[k] < minThird) minThird = cmndf[k];
        }
        if (minThird <= v + 0.035) clarity *= 0.55;
      }

      const freq = sampleRate / tauHat;
      const midiFloat = 69 + 12 * Math.log2(freq / 440);
      const m = Math.round(midiFloat);
      const err = Math.abs(midiFloat - m);
      if (m < BASS_MIN_MIDI || m > BASS_MAX_MIDI || err > 0.45) continue;

      const score = clarity * (1 - 0.5 * err) + (m >= 28 && m <= 52 ? 0.02 : 0);
      const idx = m - BASS_MIN_MIDI;
      if (score > em[idx]) em[idx] = score;
    }

    // Quiet frames favor UNVOICED while keeping mild pitched emissions if sustained.
    if (rms[f] < 0.08 * refRms) {
      for (let s = 0; s < UNVOICED; s++) em[s] -= 0.45;
    }
  }
  return emissions;
}

// ---------- frame-level Viterbi ----------

function viterbiPitch(emissions: Float64Array[], onset: Float32Array): Int8Array {
  const frames = emissions.length;
  const back = Array.from({ length: frames }, () => new Int8Array(STATES));
  let prev = Float64Array.from(emissions[0]);

  for (let f = 1; f < frames; f++) {
    const isOnset = onset[f] > 0.35;
    const stepCost = isOnset ? 0.06 : 0.18;
    const jumpCost = isOnset ? 0.1 : 0.35;
    const octCost = isOnset ? 0 : 0.3;

    // Best overall pitched state at f-1
    let bestPitched = 0;
    for (let s = 1; s < UNVOICED; s++) if (prev[s] > prev[bestPitched]) bestPitched = s;
    const bestFromAnyPitched = prev[bestPitched] - jumpCost;

    const cur = new Float64Array(STATES);
    const bp = back[f];
    const em = emissions[f];

    for (let s = 0; s < UNVOICED; s++) {
      let bestScore = prev[s];
      let bestPrev = s;

      const fromUnvoiced = prev[UNVOICED] - 0.25;
      if (fromUnvoiced > bestScore) {
        bestScore = fromUnvoiced;
        bestPrev = UNVOICED;
      }

      for (let d = -2; d <= 2; d++) {
        if (d === 0) continue;
        const p = s + d;
        if (p < 0 || p >= UNVOICED) continue;
        const cand = prev[p] - stepCost;
        if (cand > bestScore) {
          bestScore = cand;
          bestPrev = p;
        }
      }

      // General jump (avoiding exact +-12 when !isOnset, checked below if bestPitched is +-12)
      if (Math.abs(s - bestPitched) !== 12) {
        if (bestFromAnyPitched > bestScore) {
          bestScore = bestFromAnyPitched;
          bestPrev = bestPitched;
        }
      } else {
        // Evaluate bestPitched with octave penalty, or runner-up pitched state without it.
        const candOct = bestFromAnyPitched - octCost;
        if (candOct > bestScore) {
          bestScore = candOct;
          bestPrev = bestPitched;
        }
        let second = -1;
        for (let p = 0; p < UNVOICED; p++) {
          if (Math.abs(s - p) === 12) continue;
          if (second < 0 || prev[p] > prev[second]) second = p;
        }
        if (second >= 0) {
          const candSecond = prev[second] - jumpCost;
          if (candSecond > bestScore) {
            bestScore = candSecond;
            bestPrev = second;
          }
        }
      }

      cur[s] = bestScore + em[s];
      bp[s] = bestPrev;
    }

    // UNVOICED destination
    let bestScoreU = prev[UNVOICED];
    let bestPrevU = UNVOICED;
    const fromP = prev[bestPitched] - 0.25;
    if (fromP > bestScoreU) {
      bestScoreU = fromP;
      bestPrevU = bestPitched;
    }
    cur[UNVOICED] = bestScoreU + em[UNVOICED];
    bp[UNVOICED] = bestPrevU;

    prev = cur;
  }

  let s = 0;
  for (let i = 1; i < STATES; i++) if (prev[i] > prev[s]) s = i;
  const out = new Int8Array(frames);
  for (let f = frames - 1; f >= 0; f--) {
    out[f] = s === UNVOICED ? -1 : BASS_MIN_MIDI + s;
    s = back[f][s];
  }
  return out;
}

// ---------- bars, grid alignment & attack segmentation ----------

interface BarWindow {
  start: number;
  end: number;
  beats: number[];
  nextBeat: number;
}

function buildBarWindows(beats: number[], downbeat: number, meter: 3 | 4, duration: number): BarWindow[] {
  const first = ((downbeat % meter) + meter) % meter;
  const pre = (meter - first) % meter;
  const times = [...beats];
  for (let i = 0; i < pre; i++) times.unshift(2 * times[0] - times[1]);
  while (times.length % meter !== 1) times.push(2 * times.at(-1)! - times.at(-2)!);

  const windows: BarWindow[] = [];
  for (let b = 0; b * meter + meter < times.length; b++) {
    const start = times[b * meter];
    if (start >= duration) break;
    const end = times[b * meter + meter];
    windows.push({
      start,
      end,
      beats: times.slice(b * meter, b * meter + meter),
      nextBeat: end,
    });
  }
  return windows;
}

interface OnsetPeak {
  peak: number;
  start: number;
  strength: number;
}

interface RawNoteEvent {
  start: number;
  end: number;
  midi: number;
}

interface QuantEvent {
  midi: number;
  u: number;
  v: number;
  velocity: number;
  endFrame: number;
  peakStr: number;
}

/** Greedy non-maximum suppression over the onset envelope, tracking each peak's rising-edge start. */
function pickOnsetPeaks(onset: Float32Array, nmsFrames: number, minVal = 0.22): OnsetPeak[] {
  const n = onset.length;
  const cands: { f: number; v: number }[] = [];
  for (let f = 1; f + 1 < n; f++) {
    const v = onset[f];
    if (v >= minVal && v >= onset[f - 1] && v >= onset[f + 1]) {
      if (v === onset[f - 1] && cands.length && cands[cands.length - 1].f === f - 1) continue;
      cands.push({ f, v });
    }
  }
  cands.sort((a, b) => b.v - a.v || a.f - b.f);

  const blocked = new Uint8Array(n);
  const peaks: OnsetPeak[] = [];
  for (const c of cands) {
    if (blocked[c.f]) continue;
    let start = c.f;
    for (let back = 1; back <= 2 && c.f - back >= 0; back++) {
      if (onset[c.f - back] >= 0.45 * c.v) start = c.f - back;
      else break;
    }
    peaks.push({ peak: c.f, start, strength: c.v });
    const lo = Math.max(0, c.f - nmsFrames);
    const hi = Math.min(n - 1, c.f + nmsFrames);
    for (let k = lo; k <= hi; k++) blocked[k] = 1;
  }
  peaks.sort((a, b) => a.peak - b.peak);
  return peaks;
}

function metricalPenalty(stepInBar: number, division: 3 | 4): number {
  if (stepInBar === 0) return 0;
  if (stepInBar % division === 0) return 0.03;
  if (division === 4) return stepInBar % 4 === 2 ? 0.1 : 0.3;
  return stepInBar % 3 === 2 ? 0.1 : 0.26;
}

function durationPenalty(dur: number, startStep: number, endStep: number, maxDur: number, division: 3 | 4): number {
  const clean =
    division === 4
      ? dur === 1 || dur === 2 || dur === 3 || dur === 4 || dur === 6 || dur === 8 || dur === 12 || dur === 16
      : dur === 1 || dur === 2 || dur === 3 || dur === 6 || dur === 9 || dur === 12;
  let penalty = clean ? 0 : 0.18;
  if (endStep % division !== 0 && dur > 3) penalty += 0.08;
  // Avoid isolated 16th staccatos on beats/8ths when room exists for a full 8th note.
  if (division === 4 && dur === 1 && startStep % 2 === 0 && maxDur >= 2) penalty += 0.22;
  return penalty;
}

function buildStepTimeline(windows: BarWindow[], division: 3 | 4) {
  const barsCount = windows.length;
  const meter = windows[0].beats.length;
  const stepsPerBar = meter * division;
  const totalSteps = barsCount * stepsPerBar;
  const stepTimes = new Float64Array(totalSteps + 1);
  const stepLens: number[] = [];

  for (let b = 0; b < barsCount; b++) {
    const w = windows[b];
    for (let j = 0; j < w.beats.length; j++) {
      const b0 = w.beats[j];
      const b1 = j + 1 < w.beats.length ? w.beats[j + 1] : w.nextBeat;
      const sLen = (b1 - b0) / division;
      stepLens.push(sLen);
      for (let s = 0; s < division; s++) {
        stepTimes[b * stepsPerBar + j * division + s] = b0 + s * sLen;
      }
    }
  }
  stepTimes[totalSteps] = windows[barsCount - 1].end;
  const medianStepLen = percentile(stepLens, 0.5) || 0.125;

  const timeToStep = (t: number): number => {
    if (t <= stepTimes[0]) {
      const s0 = stepTimes[1] - stepTimes[0];
      return s0 > 0 ? (t - stepTimes[0]) / s0 : 0;
    }
    if (t >= stepTimes[totalSteps]) {
      const sL = stepTimes[totalSteps] - stepTimes[totalSteps - 1];
      return totalSteps + (sL > 0 ? (t - stepTimes[totalSteps]) / sL : 0);
    }
    let lo = 0;
    let hi = totalSteps;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1;
      if (stepTimes[mid] <= t) lo = mid;
      else hi = mid;
    }
    const span = stepTimes[lo + 1] - stepTimes[lo];
    return lo + (span > 0 ? (t - stepTimes[lo]) / span : 0);
  };

  return { stepsPerBar, totalSteps, medianStepLen, timeToStep };
}

function quantizeOnsets(events: QuantEvent[], totalSteps: number, stepsPerBar: number, division: 3 | 4, reAttackThreshold: number): (QuantEvent & { g: number })[] {
  const count = events.length;
  if (!count) return [];

  const maxSnap = 0.72;
  const wIoi = 0.45;
  const cands = events.map((ev) => {
    const list: number[] = [];
    const lo = Math.max(0, Math.floor(ev.u) - 1);
    const hi = Math.min(totalSteps - 1, Math.ceil(ev.u) + 1);
    for (let g = lo; g <= hi; g++) {
      if (Math.abs(g - ev.u) <= maxSnap) list.push(g);
    }
    if (!list.length) list.push(Math.max(0, Math.min(totalSteps - 1, Math.round(ev.u))));
    return list;
  });

  const emitCost = (u: number, g: number) => {
    const err = g - u;
    return err * err + metricalPenalty(g % stepsPerBar, division);
  };

  let prevDp = cands[0].map((g) => emitCost(events[0].u, g));
  const back: number[][] = [cands[0].map(() => -1)];

  for (let i = 1; i < count; i++) {
    const du = events[i].u - events[i - 1].u;
    const coupleIoi = du <= division * 2;
    const sameMidi = events[i].midi === events[i - 1].midi;
    const weakReAttack = sameMidi && events[i].peakStr < 1.35 * reAttackThreshold;
    const curC = cands[i];
    const prevC = cands[i - 1];
    const curDp = new Array<number>(curC.length);
    const bp = new Array<number>(curC.length);

    for (let j = 0; j < curC.length; j++) {
      const gB = curC[j];
      const em = emitCost(events[i].u, gB);
      let best = Infinity;
      let arg = 0;
      for (let k = 0; k < prevC.length; k++) {
        const gA = prevC[k];
        if (gB < gA) continue;
        let trans = 0;
        if (gB === gA) {
          trans = 5.0;
        } else {
          if (coupleIoi) {
            const ioiErr = gB - gA - du;
            trans += wIoi * ioiErr * ioiErr;
          }
          if (weakReAttack && gB - gA === 1) trans += 0.45;
        }
        const cand = prevDp[k] + trans + em;
        if (cand < best) {
          best = cand;
          arg = k;
        }
      }
      curDp[j] = best;
      bp[j] = arg;
    }
    prevDp = curDp;
    back.push(bp);
  }

  let bestIdx = 0;
  for (let j = 1; j < prevDp.length; j++) if (prevDp[j] < prevDp[bestIdx]) bestIdx = j;
  const snapped = new Int32Array(count);
  for (let i = count - 1; i >= 0; i--) {
    snapped[i] = cands[i][bestIdx];
    bestIdx = back[i][bestIdx];
  }

  const dedup: (QuantEvent & { g: number })[] = [];
  for (let i = 0; i < count; i++) {
    const g = snapped[i];
    const ev = events[i];
    const prev = dedup[dedup.length - 1];
    if (prev && prev.g === g) {
      if (ev.v - ev.u > prev.v - prev.u) dedup[dedup.length - 1] = { ...ev, g };
    } else {
      dedup.push({ ...ev, g });
    }
  }
  return dedup;
}

function extractBarNotes(
  windows: BarWindow[],
  frameMidi: Int8Array,
  rms: Float32Array,
  onset: Float32Array,
  refRms: number,
  fps: number,
  division: 3 | 4,
  duration: number,
): BassBar[] {
  const barsCount = windows.length;
  if (!barsCount) return [];
  const frames = frameMidi.length;
  const { stepsPerBar, totalSteps, medianStepLen, timeToStep } = buildStepTimeline(windows, division);
  const stepFrames = medianStepLen * fps;

  const nmsFrames = Math.max(4, Math.round(0.75 * stepFrames));
  const peaks = pickOnsetPeaks(onset, nmsFrames, 0.22);
  const peakAtFrame = new Int32Array(frames).fill(-1);
  peaks.forEach((p, idx) => {
    peakAtFrame[p.start] = idx;
  });

  // Bridge short 1-3 frame pitch glitches without a strong onset between identical neighbours.
  const smoothMidi = Int8Array.from(frameMidi);
  for (let span = 1; span <= 3; span++) {
    for (let f = 1; f + span < frames; f++) {
      const prev = smoothMidi[f - 1];
      if (prev < 0 || smoothMidi[f + span] !== prev) continue;
      let diff = false;
      let maxOn = 0;
      for (let k = 0; k < span; k++) {
        if (smoothMidi[f + k] !== prev) diff = true;
        if (onset[f + k] > maxOn) maxOn = onset[f + k];
      }
      if (diff && maxOn < 0.35) {
        for (let k = 0; k < span; k++) smoothMidi[f + k] = prev;
      }
    }
  }

  const attackFloor = Math.max(1e-4, 0.08 * refRms);
  const releaseFloor = Math.max(1e-4, 0.055 * refRms);
  const pitchChangeOnsets: number[] = [];
  for (let f = 2; f + 2 < frames; f++) {
    const m0 = smoothMidi[f - 1];
    const m1 = smoothMidi[f];
    if (m0 >= 0 && m1 >= 0 && m0 !== m1 && smoothMidi[f + 1] === m1 && rms[f] >= attackFloor) {
      let mx = 0;
      for (let d = -2; d <= 3; d++) {
        const k = f + d;
        if (k >= 0 && k < frames && onset[k] > mx) mx = onset[k];
      }
      if (mx > 0.15) pitchChangeOnsets.push(mx);
    }
  }
  const onsetRef = pitchChangeOnsets.length ? percentile(pitchChangeOnsets, 0.5) : 0.45;
  const reAttackThreshold = Math.max(0.32, Math.min(0.6, 0.58 * onsetRef));

  const rawEvents: RawNoteEvent[] = [];
  let active = false;
  let evStart = 0;
  let evMidi = -1;
  let offStreak = 0;

  const closeEvent = (endFrame: number) => {
    if (!active || endFrame <= evStart) {
      active = false;
      return;
    }
    const actualEnd = Math.max(evStart + 1, endFrame - offStreak);
    rawEvents.push({ start: evStart, end: actualEnd, midi: evMidi });
    active = false;
    offStreak = 0;
  };

  for (let f = 0; f < frames; f++) {
    const m = smoothMidi[f];
    const voiced = m >= 0 && rms[f] >= (active ? releaseFloor : attackFloor);
    const pIdx = peakAtFrame[f];
    const peakStr = pIdx >= 0 ? peaks[pIdx].strength : 0;

    if (!active) {
      if (voiced) {
        active = true;
        evStart = f;
        evMidi = m;
        offStreak = 0;
      }
      continue;
    }

    if (!voiced) {
      offStreak++;
      if (offStreak >= 2) closeEvent(f + 1);
      continue;
    }

    offStreak = 0;
    if (m !== evMidi) {
      closeEvent(f);
      active = true;
      evStart = f;
      evMidi = m;
    } else if (peakStr >= reAttackThreshold && f - evStart >= nmsFrames) {
      const minStr = f - evStart < 1.35 * stepFrames ? 1.25 * reAttackThreshold : reAttackThreshold;
      if (peakStr >= minStr) {
        closeEvent(f);
        active = true;
        evStart = f;
        evMidi = m;
      }
    }
  }
  if (active) closeEvent(frames);

  // Absorb transient attack/release pitch wobbles and build continuous-grid events.
  const minHardFrames = Math.max(3, Math.round(0.35 * stepFrames));
  const minUnpluckedFrames = Math.max(4, Math.round(0.55 * stepFrames));
  const events: QuantEvent[] = [];

  for (let i = 0; i < rawEvents.length; i++) {
    const ev = rawEvents[i];
    const len = ev.end - ev.start;

    let bestPeakStrength = 0;
    let attackFrame = ev.start;
    for (let k = Math.max(0, ev.start - 2); k <= Math.min(frames - 1, ev.start + 3); k++) {
      const pi = peakAtFrame[k];
      if (pi >= 0 && peaks[pi].strength > bestPeakStrength) {
        bestPeakStrength = peaks[pi].strength;
        attackFrame = peaks[pi].start;
      }
    }

    if (len < minHardFrames || (len < minUnpluckedFrames && bestPeakStrength < 0.26)) {
      const prev = events[events.length - 1];
      const next = rawEvents[i + 1];
      if (prev && ev.start - prev.endFrame <= 1 && bestPeakStrength < 0.26) {
        prev.endFrame = ev.end;
        prev.v = timeToStep(Math.min(duration, ev.end / fps));
        continue;
      }
      if (next && next.start - ev.end <= 1 && next.end - next.start >= minHardFrames) {
        next.start = ev.start;
      }
      continue;
    }

    const prev = events[events.length - 1];
    if (prev && prev.midi === ev.midi && ev.start - prev.endFrame <= 2 && bestPeakStrength < reAttackThreshold) {
      prev.endFrame = ev.end;
      prev.v = timeToStep(Math.min(duration, ev.end / fps));
      continue;
    }

    let rmsSum = 0;
    let peakRms = 0;
    const bodyEnd = Math.min(ev.end, ev.start + Math.max(4, Math.round(0.08 * fps)));
    for (let f = ev.start; f < ev.end; f++) {
      rmsSum += rms[f];
      if (f < bodyEnd && rms[f] > peakRms) peakRms = rms[f];
    }
    if (rmsSum / len < attackFloor) continue;

    const attackTime = attackFrame / fps;
    const endTime = ev.end / fps;
    if (endTime <= 0 || attackTime >= duration) continue;

    const u = timeToStep(Math.max(0, attackTime));
    const v = timeToStep(Math.min(duration, endTime));
    if (u < -0.55 || u > totalSteps - 0.45) continue;

    const velocity = Math.max(0.4, round(Math.min(1, Math.sqrt(peakRms / refRms)), 10));
    events.push({ midi: ev.midi, u, v, velocity, endFrame: ev.end, peakStr: bestPeakStrength });
  }

  const quantized = quantizeOnsets(events, totalSteps, stepsPerBar, division, reAttackThreshold);
  const barNotes: BassNote[][] = Array.from({ length: barsCount }, () => []);

  for (let i = 0; i < quantized.length; i++) {
    const ev = quantized[i];
    const b = Math.floor(ev.g / stepsPerBar);
    if (b < 0 || b >= barsCount) continue;
    const s = ev.g - b * stepsPerBar;
    const barEnd = (b + 1) * stepsPerBar;
    const nextG = i + 1 < quantized.length ? quantized[i + 1].g : totalSteps;
    const maxEnd = Math.min(barEnd, nextG);
    if (maxEnd <= ev.g) continue;

    let endG: number;
    if (ev.v >= maxEnd - 0.65) {
      endG = maxEnd;
    } else {
      let bestEnd = Math.max(ev.g + 1, Math.min(maxEnd, Math.round(ev.v)));
      let bestCost = Infinity;
      const targetEnd = Math.min(maxEnd, ev.v + 0.2);
      const lo = Math.max(ev.g + 1, Math.floor(ev.v) - 1);
      const hi = Math.min(maxEnd, Math.ceil(ev.v) + 1);
      for (let cand = lo; cand <= hi; cand++) {
        if (Math.abs(cand - ev.v) > 0.75) continue;
        const dErr = cand - targetEnd;
        const cost = dErr * dErr + durationPenalty(cand - ev.g, s, cand - b * stepsPerBar, maxEnd - ev.g, division);
        if (cost < bestCost) {
          bestCost = cost;
          bestEnd = cand;
        }
      }
      endG = bestEnd;
    }

    barNotes[b].push({
      step: s,
      midi: ev.midi,
      string: 0,
      fret: 0,
      duration: Math.max(1, endG - ev.g),
      velocity: ev.velocity,
    });
  }

  return windows.map((w, b) => ({
    start: round(Math.max(0, w.start), 1000),
    end: round(Math.min(duration, w.end), 1000),
    beats: w.beats.map((t) => round(t, 1000)),
    kind: 'rest',
    riff: -1,
    repeat: false,
    notes: barNotes[b],
  }));
}

// ---------- 4/5-string fingering & transposition ----------

/** Transposes a MIDI note into the playable 4-string [28..63] or 5-string [23..63] bass range. */
export function transposeBassMidi(midi: number, pitchShift: number, strings: BassStringCount = 5): number {
  const minMidi = strings === 4 ? BASS_TUNING[3] : BASS_MIN_MIDI;
  let m = midi + pitchShift;
  while (m < minMidi) m += 12;
  while (m > BASS_MAX_MIDI) m -= 12;
  return m;
}

const FRET_SPAN = BASS_MAX_FRET + 1;
const MAX_HAND_POS = BASS_MAX_FRET - 2;
const FRET_POS = Float64Array.from({ length: FRET_SPAN }, (_, f) => 1 - Math.pow(2, -f / 12));
const PHYS_DIST = new Float64Array(FRET_SPAN * FRET_SPAN);
for (let a = 0; a < FRET_SPAN; a++) {
  for (let b = 0; b < FRET_SPAN; b++) {
    PHYS_DIST[a * FRET_SPAN + b] = 20 * Math.abs(FRET_POS[b] - FRET_POS[a]);
  }
}

interface FingeringStates {
  len: number;
  s: Int8Array;
  f: Int8Array;
  p: Int8Array;
  c: Float64Array;
}

function buildFingeringStates(midi: number, strings: BassStringCount, maxOpenPos: number): FingeringStates {
  const sArr: number[] = [];
  const fArr: number[] = [];
  const pArr: number[] = [];
  const cArr: number[] = [];
  for (let s = 0; s < strings; s++) {
    const f = midi - BASS_TUNING[s];
    if (f < 0 || f > BASS_MAX_FRET) continue;
    if (f === 0) {
      // Emit one state per hand position so open strings carry the active hand box forward.
      for (let pos = 1; pos <= maxOpenPos; pos++) {
        sArr.push(s);
        fArr.push(0);
        pArr.push(pos);
        cArr.push(0.08 + 0.14 * (pos - 1));
      }
    } else {
      let base = f <= 7 ? 0.025 * (f - 1) : f <= 12 ? 0.15 + 0.08 * (f - 7) : 0.55 + 0.28 * (f - 12);
      if (s === 4 && f > 5) base += f <= 7 ? 0.08 * (f - 5) : 0.16 + 0.45 * (f - 7);
      if (s === 3 && f > 9) base += 0.12 * (f - 9);
      if (s === 2 && f > 11) base += 0.1 * (f - 11);

      const minPos = Math.max(1, f - 3);
      const maxPos = Math.min(MAX_HAND_POS, f);
      for (let pos = minPos; pos <= maxPos; pos++) {
        const off = f - pos;
        const stretch = off === 3 ? (pos === 1 ? 0.45 : pos === 2 ? 0.25 : pos === 3 ? 0.08 : 0) : 0;
        sArr.push(s);
        fArr.push(f);
        pArr.push(pos);
        cArr.push(base + stretch + 0.02 * off);
      }
    }
  }
  return {
    len: sArr.length,
    s: Int8Array.from(sArr),
    f: Int8Array.from(fArr),
    p: Int8Array.from(pArr),
    c: Float64Array.from(cArr),
  };
}

function isErgonomicOctave(sA: number, fA: number, sB: number, fB: number, midiA: number, midiB: number): boolean {
  if (Math.abs(midiB - midiA) !== 12 || Math.abs(sB - sA) !== 2) return false;
  const lowS = midiA < midiB ? sA : sB;
  const highS = midiA < midiB ? sB : sA;
  if (highS >= lowS) return false;
  const lowF = midiA < midiB ? fA : fB;
  const highF = midiA < midiB ? fB : fA;
  return (lowF === 0 && highF === 2) || (lowF > 0 && highF - lowF === 2);
}

/** Assigns playable 4-string or 5-string (string, fret) coordinates across the song using hand-position DP. */
export function assignBassFingering(bars: BassBar[], pitchShift = 0, strings: BassStringCount = 5, division: 3 | 4 = 4): BassBar[] {
  const flatBar: number[] = [];
  const flatNote: number[] = [];
  const flatAbsStep: number[] = [];
  const flatDur: number[] = [];
  const flatMidi: number[] = [];
  let maxNeededFret = 5;
  let barStepOffset = 0;

  bars.forEach((bar, b) => {
    const spb = (bar.beats.length || 4) * division;
    bar.notes.forEach((n, idx) => {
      const midi = transposeBassMidi(n.midi, pitchShift, strings);
      flatBar.push(b);
      flatNote.push(idx);
      flatAbsStep.push(barStepOffset + n.step);
      flatDur.push(n.duration);
      flatMidi.push(midi);
      const minFretForMidi = Math.max(0, midi - BASS_TUNING[0]);
      if (minFretForMidi > maxNeededFret) maxNeededFret = minFretForMidi;
    });
    barStepOffset += spb;
  });

  const count = flatMidi.length;
  if (!count) return bars;

  const maxOpenPos = Math.min(12, Math.max(7, maxNeededFret));
  const stateCache = new Map<number, FingeringStates>();
  const states: FingeringStates[] = new Array(count);
  for (let i = 0; i < count; i++) {
    const midi = flatMidi[i];
    let st = stateCache.get(midi);
    if (!st) {
      st = buildFingeringStates(midi, strings, maxOpenPos);
      stateCache.set(midi, st);
    }
    states[i] = st;
  }

  let prevDp = Float64Array.from(states[0].c);
  const back: Int16Array[] = new Array(count);
  back[0] = new Int16Array(states[0].len).fill(-1);

  for (let i = 1; i < count; i++) {
    const prev = states[i - 1];
    const cur = states[i];
    const midiA = flatMidi[i - 1];
    const midiB = flatMidi[i];
    const sameMidi = midiA === midiB;
    const isOctInterval = Math.abs(midiB - midiA) === 12;
    const stepGap = Math.max(1, flatAbsStep[i] - flatAbsStep[i - 1]);
    const restGap = Math.max(0, flatAbsStep[i] - (flatAbsStep[i - 1] + flatDur[i - 1]));
    const samePitchPen = restGap >= 8 ? 0.5 : 4.0;
    const scale =
      restGap >= 16
        ? 0.1
        : restGap >= 8
          ? 0.25
          : restGap >= 4
            ? 0.5
            : restGap >= 2
              ? 0.75
              : restGap >= 1
                ? 0.9
                : stepGap <= 1
                  ? 1.3
                  : stepGap === 2
                    ? 1.05
                    : 0.95;

    const cLen = cur.len;
    const pLen = prev.len;
    const curDp = new Float64Array(cLen);
    const bp = new Int16Array(cLen);
    const pS = prev.s;
    const pF = prev.f;
    const pP = prev.p;
    const cS = cur.s;
    const cF = cur.f;
    const cP = cur.p;
    const cC = cur.c;

    for (let j = 0; j < cLen; j++) {
      const sB = cS[j];
      const fB = cF[j];
      const posB = cP[j];
      let best = Infinity;
      let arg = 0;
      for (let k = 0; k < pLen; k++) {
        const basePrev = prevDp[k];
        if (basePrev >= best) continue;

        const sA = pS[k];
        const fA = pF[k];
        const posA = pP[k];
        const samePitchCost = sameMidi && sA !== sB ? samePitchPen : 0;

        const dPos = posB > posA ? posB - posA : posA - posB;
        const df = fA > 0 && fB > 0 ? (fB > fA ? fB - fA : fA - fB) : 0;
        let shiftCost = 0;
        if (dPos > 0) {
          const pShift = PHYS_DIST[posA * FRET_SPAN + posB];
          shiftCost = 0.65 + 0.6 * pShift + (dPos > 2 ? 0.4 * (dPos - 2) : 0);
          if (sA === sB && fA > 0 && fB > 0 && df <= 3) shiftCost *= 0.75;
          // Allow an open string to ease the glide into the next fretted note, while discouraging
          // premature drift when entering an open string so large jumps cannot be split in two.
          if (fA === 0 && fB > 0) shiftCost *= 0.75;
          else if (fB === 0) shiftCost *= 1.5;
        }

        const ds = sB > sA ? sB - sA : sA - sB;
        const oct = isOctInterval && ds === 2 && isErgonomicOctave(sA, fA, sB, fB, midiA, midiB);

        let fingerMove = 0;
        if (fA > 0 && fB > 0) {
          const pDist = PHYS_DIST[fA * FRET_SPAN + fB];
          fingerMove = 0.08 * pDist;
          if (df >= 4) {
            fingerMove += 0.95 * (df - 3) + 0.25 * pDist;
          } else if (df === 3 && ds >= 1 && !oct) {
            fingerMove += 0.35 + (fA <= 2 || fB <= 2 ? 0.25 : 0);
          }
        }

        let strCost = 0;
        if (ds === 1) {
          strCost = 0.2 + (fA > 0 && fA === fB ? 0.08 : 0);
        } else if (ds === 2) {
          strCost = oct ? 0.18 : 0.75;
        } else if (ds === 3) {
          strCost = 1.65;
        } else if (ds >= 4) {
          strCost = 2.6;
        }

        const cand = basePrev + samePitchCost + (shiftCost + fingerMove + strCost) * scale;
        if (cand < best) {
          best = cand;
          arg = k;
        }
      }
      curDp[j] = best + cC[j];
      bp[j] = arg;
    }
    prevDp = curDp;
    back[i] = bp;
  }

  let bestIdx = 0;
  for (let j = 1; j < prevDp.length; j++) if (prevDp[j] < prevDp[bestIdx]) bestIdx = j;

  const out = bars.map((bar) => ({ ...bar, notes: bar.notes.map((n) => ({ ...n })) }));
  for (let i = count - 1; i >= 0; i--) {
    const st = states[i];
    const target = out[flatBar[i]].notes[flatNote[i]];
    target.midi = flatMidi[i];
    target.string = st.s[bestIdx];
    target.fret = st.f[bestIdx];
    bestIdx = back[i][bestIdx];
  }
  return out;
}

// ---------- riff clustering & road map ----------

function barPitchGrid(bar: BassBar, stepsPerBar: number): Int16Array {
  const grid = new Int16Array(stepsPerBar).fill(-1);
  for (const n of bar.notes) if (n.step >= 0 && n.step < stepsPerBar) grid[n.step] = n.midi;
  return grid;
}

function bassDistance(a: Int16Array, b: Int16Array): number {
  let d = 0;
  for (let s = 0; s < a.length; s++) {
    if (a[s] !== b[s]) d += a[s] >= 0 && b[s] >= 0 ? 1 : 0.75;
  }
  return d;
}

function bassTolerance(aCount: number, bCount: number): number {
  return Math.max(1.5, 0.3 * Math.min(aCount, bCount));
}

function lastBeatNoteCount(bar: BassBar, division: number): number {
  const from = (bar.beats.length - 1) * division;
  return bar.notes.filter((n) => n.step >= from).length;
}

function labelBassBars(bars: BassBar[], division: number) {
  if (!bars.length) return;
  const stepsPerBar = bars[0].beats.length * division;
  const active = bars.map((bar) => bar.notes.length >= 1);
  const grids = bars.map((bar) => barPitchGrid(bar, stepsPerBar));
  const counts = bars.map((bar) => bar.notes.length);

  let protos: { grid: Int16Array; count: number }[] = [];
  let cluster = bars.map(() => -1);

  const assign = () =>
    bars.forEach((_, i) => {
      if (!active[i]) return;
      let best = -1;
      let bestD = Infinity;
      protos.forEach((p, c) => {
        const d = bassDistance(grids[i], p.grid);
        if (d <= bassTolerance(counts[i], p.count) && d < bestD) {
          best = c;
          bestD = d;
        }
      });
      if (best < 0) {
        protos.push({ grid: grids[i], count: counts[i] });
        best = protos.length - 1;
      }
      cluster[i] = best;
    });

  assign();
  protos = protos.map((_, c) => majorityBassGrid(bars.filter((_, i) => cluster[i] === c), stepsPerBar));
  cluster = bars.map(() => -1);
  assign();

  const size = new Map<number, number>();
  cluster.forEach((c) => c >= 0 && size.set(c, (size.get(c) ?? 0) + 1));
  const medianNotes = percentile(
    bars.filter((_, i) => active[i]).map((b) => b.notes.length),
    0.5,
  );

  const fill = bars.map((bar, i) => {
    if (cluster[i] < 0 || size.get(cluster[i])! > 1) return false;
    const prev = bars[i - 1];
    return (
      bar.notes.length >= Math.max(3, 1.4 * medianNotes) ||
      (lastBeatNoteCount(bar, division) >= 3 && !!prev && lastBeatNoteCount(bar, division) >= lastBeatNoteCount(prev, division) + 2)
    );
  });

  // Non-fill singletons join the closest multi-bar riff if within 2× tolerance.
  bars.forEach((_, i) => {
    if (cluster[i] < 0 || fill[i] || size.get(cluster[i])! > 1) return;
    let best = -1;
    let bestD = Infinity;
    protos.forEach((p, c) => {
      const d = bassDistance(grids[i], p.grid);
      if (c !== cluster[i] && size.get(c)! > 1 && d <= 2 * bassTolerance(counts[i], p.count) && d < bestD) {
        best = c;
        bestD = d;
      }
    });
    if (best >= 0) cluster[i] = best;
  });

  const numbers = new Map<number, number>();
  bars.forEach((bar, i) => {
    if (cluster[i] < 0) return;
    if (fill[i]) {
      bar.kind = 'fill';
      bar.riff = -1;
      bar.repeat = false;
      return;
    }
    if (!numbers.has(cluster[i])) numbers.set(cluster[i], numbers.size);
    bar.kind = 'riff';
    bar.riff = numbers.get(cluster[i])!;
    const prev = bars[i - 1];
    bar.repeat = !!prev && prev.kind === 'riff' && prev.riff === bar.riff;
  });
}

function majorityBassGrid(group: BassBar[], stepsPerBar: number): { grid: Int16Array; count: number } {
  const grid = new Int16Array(stepsPerBar).fill(-1);
  let count = 0;
  for (let s = 0; s < stepsPerBar; s++) {
    const hits = new Map<number, number>();
    let total = 0;
    for (const b of group) {
      const n = b.notes.find((note) => note.step === s);
      if (n) {
        total++;
        hits.set(n.midi, (hits.get(n.midi) ?? 0) + 1);
      }
    }
    if (total * 2 >= group.length) {
      let bestMidi = -1;
      let bestCount = -1;
      hits.forEach((c, m) => {
        if (c > bestCount) {
          bestCount = c;
          bestMidi = m;
        }
      });
      grid[s] = bestMidi;
      count++;
    }
  }
  return { grid, count };
}

/** Song road map: consecutive runs of one riff (×count), fills, and rests. */
export function bassRoadMap(bars: BassBar[], stepsPerBar: number): BassSection[] {
  const out: BassSection[] = [];
  bars.forEach((bar, i) => {
    const last = out.at(-1);
    const joins = last && bar.kind !== 'fill' && last.kind === bar.kind && last.riff === bar.riff;
    if (joins) {
      last.count++;
      last.end = bar.end;
    } else {
      out.push({ kind: bar.kind, riff: bar.riff, first: i, count: 1, start: bar.start, end: bar.end, notes: bar.notes, steps: stepsPerBar });
    }
  });
  return out;
}

function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

function round(x: number, scale: number): number {
  return Math.round(x * scale) / scale;
}
