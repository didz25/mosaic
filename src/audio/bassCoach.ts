/**
 * Real-time bass pitch detection and coaching evaluator (100% client-side).
 *
 * Pure module with zero DOM or Web Audio dependencies so both the DSP pitch detector
 * and the bar/pass coaching engine are deterministically unit-testable.
 */

import { bassStrings, type BassBar, type BassStringCount } from './bass';

export type NoteGrade = 'hit' | 'timing' | 'wrong' | 'missed';

export interface LivePitchFrame {
  rms: number;
  freq: number | null;
  midiFloat: number | null;
  midi: number | null;
  cents: number;
  noteName: string | null;
  clarity: number;
  isOnset: boolean;
}

export interface CoachTargetNote {
  id: string;
  barIndex: number;
  step: number;
  time: number;
  endTime: number;
  midi: number;
  string: number;
  fret: number;
}

export interface EvaluatedNote {
  target: CoachTargetNote;
  grade: NoteGrade;
  playedMidi: number | null;
  semitoneDiff: number | null;
  timingMs: number | null;
  centsOff: number | null;
  cue: string;
}

export interface CoachTip {
  id: string;
  kind: 'note' | 'timing' | 'tuning' | 'speed' | 'praise';
  text: string;
  barIndex?: number;
  suggestedSpeed?: number;
}

export interface PassRecord {
  pass: number;
  accuracy: number;
  pitchAccuracy: number;
  evaluated: number;
}

export interface CoachSnapshot {
  grades: Map<string, NoteGrade>;
  evaluatedCount: number;
  hits: number;
  timingIssues: number;
  wrongNotes: number;
  missedNotes: number;
  accuracy: number | null;
  pitchAccuracy: number | null;
  avgTimingMs: number | null;
  avgCents: number | null;
  streak: number;
  bestStreak: number;
  currentTarget: CoachTargetNote | null;
  liveCue: string;
  liveCueKind: 'neutral' | 'hit' | 'warn' | 'miss';
  tips: CoachTip[];
  passes: PassRecord[];
  bestPassAccuracy: number | null;
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;
const MIN_MIDI = 22;
const MAX_MIDI = 64;
const MIN_FREQ = 28;
const MAX_FREQ = 350;

/** Convert MIDI note number (e.g. 28 -> "E1", 23 -> "B0") into a readable note name. */
export function midiToNoteName(midi: number): string {
  const m = Math.round(midi);
  const name = NOTE_NAMES[((m % 12) + 12) % 12];
  const octave = Math.floor(m / 12) - 1;
  return `${name}${octave}`;
}

/** Human-readable string+fret label (e.g. "E-0", "A-5", "B-3"). */
export function fretLabel(stringIdx: number, fret: number, strings: BassStringCount): string {
  const names = bassStrings(strings);
  const s = names[stringIdx] ?? names[names.length - 1];
  return `${s}-${fret}`;
}

function stepToTime(bar: BassBar, step: number, division: 3 | 4): number {
  const meter = bar.beats.length || 4;
  if (step <= 0) return bar.start;
  if (step >= meter * division) return bar.end;
  const b = Math.floor(step / division);
  const frac = (step % division) / division;
  const beatStart = bar.beats[b] ?? bar.start;
  const beatEnd = bar.beats[b + 1] ?? bar.end;
  return beatStart + frac * (beatEnd - beatStart);
}

/** Flatten all bar notes into chronologically sorted coaching targets with start/end times. */
export function flattenBassTargets(bars: BassBar[], division: 3 | 4): CoachTargetNote[] {
  const out: CoachTargetNote[] = [];
  for (let b = 0; b < bars.length; b++) {
    const bar = bars[b];
    if (!bar.notes.length) continue;
    for (const n of bar.notes) {
      const time = stepToTime(bar, n.step, division);
      const endTime = Math.max(time + 0.04, stepToTime(bar, n.step + n.duration, division));
      out.push({
        id: `${b}:${n.step}`,
        barIndex: b,
        step: n.step,
        time,
        endTime,
        midi: n.midi,
        string: n.string,
        fret: n.fret,
      });
    }
  }
  out.sort((a, b) => a.time - b.time);
  return out;
}

/**
 * Real-time YIN bass pitch detector on a time-domain microphone/interface buffer.
 * Supports 4- and 5-string bass range (B0 30.87 Hz through ~E4 330 Hz) with subharmonic
 * and weak-fundamental octave guards.
 */
export function detectLiveBassPitch(
  samples: Float32Array,
  sampleRate: number,
  options?: { minRms?: number; prevRms?: number; prevMidi?: number | null },
): LivePitchFrame {
  const minRms = options?.minRms ?? 0.008;
  const prevRms = options?.prevRms ?? 0;
  const prevMidi = options?.prevMidi ?? null;

  if (samples.length < 128 || sampleRate <= 0) {
    return { rms: 0, freq: null, midiFloat: null, midi: null, cents: 0, noteName: null, clarity: 0, isOnset: false };
  }

  let sumSq = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i];
    sumSq += v * v;
  }
  const rms = Math.sqrt(sumSq / samples.length);
  if (rms < minRms) {
    return { rms, freq: null, midiFloat: null, midi: null, cents: 0, noteName: null, clarity: 0, isOnset: false };
  }

  // Boxcar-average and decimate to ~11-12 kHz so a 4096-sample window covers B0 cleanly in < 0.3 ms.
  const dec = Math.max(1, Math.floor(sampleRate / 11025));
  const sr = sampleRate / dec;
  const m = Math.floor(samples.length / dec);
  const sig = new Float32Array(m);

  const aHp = Math.exp((-2 * Math.PI * 25) / sr);
  const aLp = 1 - Math.exp((-2 * Math.PI * 900) / sr);
  let hp = 0;
  let prevX = 0;
  for (let j = 0; j < dec; j++) prevX += samples[j];
  prevX /= dec;
  let lp1 = 0;
  let lp2 = 0;

  for (let i = 0; i < m; i++) {
    let avg = 0;
    const base = i * dec;
    for (let j = 0; j < dec; j++) avg += samples[base + j];
    avg /= dec;
    hp = aHp * (hp + avg - prevX);
    prevX = avg;
    lp1 += aLp * (hp - lp1);
    lp2 += aLp * (lp1 - lp2);
    sig[i] = lp2;
  }

  const tauMin = Math.max(2, Math.floor(sr / MAX_FREQ));
  const desiredW = Math.round(sr * 0.052);
  const W = Math.min(Math.floor(m / 2), desiredW);
  const maxLag = Math.min(m - W - 1, Math.ceil(sr / MIN_FREQ));
  if (W < 16 || maxLag <= tauMin + 2) {
    return { rms, freq: null, midiFloat: null, midi: null, cents: 0, noteName: null, clarity: 0, isOnset: false };
  }

  const cmndf = new Float64Array(maxLag + 2);
  cmndf[0] = 1;
  let runningSum = 0;
  for (let tau = 1; tau <= maxLag; tau++) {
    let diffSq = 0;
    for (let i = 0; i < W; i++) {
      const d = sig[i] - sig[i + tau];
      diffSq += d * d;
    }
    runningSum += diffSq;
    cmndf[tau] = runningSum > 0 ? (diffSq * tau) / runningSum : 1;
  }

  // First local minimum under 0.28, falling back to global minimum under 0.40.
  let bestTau = -1;
  for (let tau = tauMin + 1; tau < maxLag; tau++) {
    const v = cmndf[tau];
    if (v < 0.28 && v <= cmndf[tau - 1] && v <= cmndf[tau + 1]) {
      bestTau = tau;
      break;
    }
  }
  if (bestTau < 0) {
    let minVal = 0.4;
    for (let tau = tauMin + 1; tau < maxLag; tau++) {
      if (cmndf[tau] < minVal && cmndf[tau] <= cmndf[tau - 1] && cmndf[tau] <= cmndf[tau + 1]) {
        minVal = cmndf[tau];
        bestTau = tau;
      }
    }
  }
  if (bestTau < 0) {
    return { rms, freq: null, midiFloat: null, midi: null, cents: 0, noteName: null, clarity: 0, isOnset: false };
  }

  // Guard 1: weak-fundamental bass tones (2nd harmonic period picked first, true T0 is much deeper).
  for (const mult of [2, 3]) {
    const target = Math.round(bestTau * mult);
    if (target >= maxLag) continue;
    let cand = target;
    for (let k = Math.max(tauMin + 1, target - 2); k <= Math.min(maxLag - 1, target + 2); k++) {
      if (cmndf[k] < cmndf[cand]) cand = k;
    }
    if (cmndf[cand] < cmndf[bestTau] * 0.55 && cmndf[cand] < 0.12) {
      bestTau = cand;
      break;
    }
  }

  // Guard 2: subharmonic check (2*T0 or 3*T0 picked when T0 already had a strong dip).
  for (const div of [2, 3]) {
    const sub = Math.round(bestTau / div);
    if (sub <= tauMin) continue;
    let cand = sub;
    for (let k = Math.max(tauMin + 1, sub - 2); k <= Math.min(maxLag - 1, sub + 2); k++) {
      if (cmndf[k] < cmndf[cand]) cand = k;
    }
    if (cmndf[cand] <= cmndf[bestTau] * 1.18 && cmndf[cand] < 0.25) {
      bestTau = cand;
      break;
    }
  }

  const denom = cmndf[bestTau - 1] - 2 * cmndf[bestTau] + cmndf[bestTau + 1];
  const delta = denom !== 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (cmndf[bestTau - 1] - cmndf[bestTau + 1])) / denom)) : 0;
  const tauHat = bestTau + delta;
  if (tauHat <= 0) {
    return { rms, freq: null, midiFloat: null, midi: null, cents: 0, noteName: null, clarity: 0, isOnset: false };
  }

  const freq = sr / tauHat;
  const midiFloat = 69 + 12 * Math.log2(freq / 440);
  const midi = Math.round(midiFloat);
  if (midi < MIN_MIDI || midi > MAX_MIDI) {
    return { rms, freq: null, midiFloat: null, midi: null, cents: 0, noteName: null, clarity: 0, isOnset: false };
  }

  const cents = Math.round((midiFloat - midi) * 100);
  const clarity = Math.max(0, Math.min(1, 1 - cmndf[bestTau]));
  const isOnset = prevMidi === null || prevMidi !== midi || (prevRms > 0 && rms > prevRms * 1.38 && rms > minRms * 2);

  return {
    rms,
    freq,
    midiFloat,
    midi,
    cents,
    noteName: midiToNoteName(midi),
    clarity,
    isOnset,
  };
}

function describePitchCorrection(diff: number, targetName: string, targetFret: string): string {
  if (diff === 12) return `1 octave too high — play ${targetName} (${targetFret})`;
  if (diff === -12) return `1 octave too low — play ${targetName} (${targetFret})`;
  if (diff === 1) return `1 fret too high — move down to ${targetName} (${targetFret})`;
  if (diff === -1) return `1 fret too low — move up to ${targetName} (${targetFret})`;
  if (diff > 0) return `${diff} frets too high — move down to ${targetName} (${targetFret})`;
  return `${-diff} frets too low — move up to ${targetName} (${targetFret})`;
}

interface ProvisionalWrong {
  target: CoachTargetNote;
  playedMidi: number;
  semitoneDiff: number;
  timingMs: number;
  centsOff: number;
}

const HIT_TOLERANCE_MS = 115;
const EARLY_WINDOW_SEC = 0.22;
const LATE_WINDOW_SEC = 0.28;

/**
 * Stateful bass coaching evaluator tracking note hits, timing offsets, intonation,
 * pass history across A-B loops, and ranked actionable improvement tips.
 */
export class BassCoachSession {
  private targets: CoachTargetNote[] = [];
  private strings: BassStringCount = 5;
  private grades = new Map<string, NoteGrade>();
  private gradesSnapshot = new Map<string, NoteGrade>();
  private results = new Map<string, EvaluatedNote>();
  private provisionalWrong = new Map<string, ProvisionalWrong>();
  private passes: PassRecord[] = [];
  private bestPassAccuracy: number | null = null;
  private streak = 0;
  private bestStreak = 0;
  private wasPlaying = false;
  private prevTrackTime: number | null = null;
  private activeFromTime = 0;
  private lastSpeed = 1;
  private liveCue = 'Play a bass note to tune or play along';
  private liveCueKind: CoachSnapshot['liveCueKind'] = 'neutral';

  constructor(bars: BassBar[] = [], division: 3 | 4 = 4, strings: BassStringCount = 5) {
    this.setBars(bars, division, strings);
  }

  setBars(bars: BassBar[], division: 3 | 4, strings: BassStringCount) {
    this.strings = strings;
    this.targets = flattenBassTargets(bars, division);
    this.reset();
  }

  reset() {
    this.grades.clear();
    this.gradesSnapshot = new Map();
    this.results.clear();
    this.provisionalWrong.clear();
    this.passes = [];
    this.bestPassAccuracy = null;
    this.streak = 0;
    this.bestStreak = 0;
    this.wasPlaying = false;
    this.prevTrackTime = null;
    this.activeFromTime = 0;
    this.liveCue = 'Play a bass note to tune or play along';
    this.liveCueKind = 'neutral';
  }

  private clearPass() {
    if (this.grades.size > 0) {
      this.grades.clear();
      this.gradesSnapshot = new Map();
    }
    this.results.clear();
    this.provisionalWrong.clear();
    this.streak = 0;
  }

  private setGrade(id: string, grade: NoteGrade) {
    if (this.grades.get(id) === grade) return;
    this.grades.set(id, grade);
    this.gradesSnapshot = new Map(this.grades);
  }

  private findCurrentTarget(trackTime: number): CoachTargetNote | null {
    for (const t of this.targets) {
      if (trackTime >= t.time - 0.15 && trackTime <= t.endTime + 0.1) return t;
      if (t.time >= trackTime - 0.1) return t;
    }
    return null;
  }

  update(
    frame: LivePitchFrame,
    trackTime: number,
    options: { playing: boolean; speed: number; latencyMs: number; strings: BassStringCount },
  ): CoachSnapshot {
    const { playing, speed, latencyMs, strings } = options;
    this.strings = strings;
    this.lastSpeed = speed;
    const alignedTime = trackTime - (latencyMs / 1000) * speed;

    if (!playing) {
      this.wasPlaying = false;
      this.prevTrackTime = trackTime;
      const currentTarget = this.findCurrentTarget(trackTime);
      if (frame.midi !== null) {
        if (currentTarget && Math.abs(currentTarget.time - trackTime) < 4) {
          const targetName = midiToNoteName(currentTarget.midi);
          const label = fretLabel(currentTarget.string, currentTarget.fret, strings);
          const diff = frame.midi - currentTarget.midi;
          if (diff === 0) {
            if (Math.abs(frame.cents) <= 18) {
              this.liveCue = `Spot on! ${targetName} (${label})`;
              this.liveCueKind = 'hit';
            } else {
              this.liveCue = `${targetName} (${label}) · ${frame.cents > 0 ? '+' : ''}${frame.cents}¢`;
              this.liveCueKind = 'warn';
            }
          } else {
            this.liveCue = describePitchCorrection(diff, targetName, label);
            this.liveCueKind = 'miss';
          }
        } else if (Math.abs(frame.cents) <= 15) {
          this.liveCue = `${frame.noteName} · In tune`;
          this.liveCueKind = 'hit';
        } else {
          this.liveCue = `${frame.noteName} · ${frame.cents > 0 ? 'Sharp' : 'Flat'} (${frame.cents > 0 ? '+' : ''}${frame.cents}¢)`;
          this.liveCueKind = 'warn';
        }
      } else {
        this.liveCue = currentTarget
          ? `Ready: ${midiToNoteName(currentTarget.midi)} (${fretLabel(currentTarget.string, currentTarget.fret, strings)})`
          : 'Play a bass note…';
        this.liveCueKind = 'neutral';
      }
      return this.getSnapshot(currentTarget);
    }

    if (!this.wasPlaying) {
      this.wasPlaying = true;
      this.activeFromTime = this.prevTrackTime !== null ? this.prevTrackTime - 0.05 : alignedTime - 0.16 * speed;
    } else if (this.prevTrackTime !== null) {
      if (trackTime < this.prevTrackTime - 0.25) {
        // Loop wrap or backward seek: archive pass if at least 2 notes were evaluated.
        const summary = this.computeCounts();
        if (summary.evaluatedCount >= 2 && summary.accuracy !== null && summary.pitchAccuracy !== null) {
          const rec: PassRecord = {
            pass: this.passes.length + 1,
            accuracy: summary.accuracy,
            pitchAccuracy: summary.pitchAccuracy,
            evaluated: summary.evaluatedCount,
          };
          this.passes = [...this.passes.slice(-7), rec];
          this.bestPassAccuracy = this.bestPassAccuracy === null ? rec.accuracy : Math.max(this.bestPassAccuracy, rec.accuracy);
        }
        this.clearPass();
        this.activeFromTime = alignedTime - 0.05;
      } else if (trackTime > this.prevTrackTime + 0.8) {
        this.activeFromTime = alignedTime - 0.05;
        for (const [id, p] of this.provisionalWrong) {
          if (p.target.time < this.activeFromTime) this.provisionalWrong.delete(id);
        }
      }
    }
    this.prevTrackTime = trackTime;

    const earlyWin = EARLY_WINDOW_SEC * speed;
    const lateWin = LATE_WINDOW_SEC * speed;
    let activeWindowWrong: { diff: number; targetName: string; label: string } | null = null;

    for (const t of this.targets) {
      if (this.grades.has(t.id)) continue;
      if (t.time < this.activeFromTime - 0.08) continue;

      if (alignedTime > t.time + lateWin) {
        const prov = this.provisionalWrong.get(t.id);
        this.provisionalWrong.delete(t.id);
        const targetName = midiToNoteName(t.midi);
        const label = fretLabel(t.string, t.fret, strings);
        if (prov) {
          const cue = describePitchCorrection(prov.semitoneDiff, targetName, label);
          this.setGrade(t.id, 'wrong');
          this.results.set(t.id, {
            target: t,
            grade: 'wrong',
            playedMidi: prov.playedMidi,
            semitoneDiff: prov.semitoneDiff,
            timingMs: prov.timingMs,
            centsOff: prov.centsOff,
            cue,
          });
          this.streak = 0;
          this.liveCue = cue;
          this.liveCueKind = 'miss';
        } else {
          const cue = `Missed ${targetName} (${label})`;
          this.setGrade(t.id, 'missed');
          this.results.set(t.id, {
            target: t,
            grade: 'missed',
            playedMidi: null,
            semitoneDiff: null,
            timingMs: null,
            centsOff: null,
            cue,
          });
          this.streak = 0;
          this.liveCue = cue;
          this.liveCueKind = 'miss';
        }
        continue;
      }

      if (frame.midi !== null && alignedTime >= t.time - earlyWin && alignedTime <= Math.max(t.endTime, t.time + lateWin)) {
        const midiErr = Math.abs(frame.midiFloat! - t.midi);
        const semitoneDiff = frame.midi - t.midi;
        const timingMs = Math.round(((alignedTime - t.time) / Math.max(0.25, speed)) * 1000);
        const centsOff = Math.round((frame.midiFloat! - t.midi) * 100);
        const targetName = midiToNoteName(t.midi);
        const label = fretLabel(t.string, t.fret, strings);

        if (midiErr <= 0.55 || semitoneDiff === 0) {
          // Avoid grabbing the next repeated note early unless a fresh pluck onset just happened.
          if (!frame.isOnset && alignedTime < t.time - 0.04 * speed) continue;

          const grade: NoteGrade = Math.abs(timingMs) <= HIT_TOLERANCE_MS ? 'hit' : 'timing';
          let cue: string;
          let cueKind: CoachSnapshot['liveCueKind'];
          if (grade === 'hit') {
            this.streak += 1;
            this.bestStreak = Math.max(this.bestStreak, this.streak);
            if (Math.abs(centsOff) > 18) {
              cue = `${targetName} (${label}) · ${centsOff > 0 ? '+' : ''}${centsOff}¢`;
              cueKind = 'warn';
            } else {
              cue = `Hit! ${targetName} (${label})`;
              cueKind = 'hit';
            }
          } else {
            this.streak = 0;
            cue = `${timingMs < 0 ? 'Early' : 'Late'} (${timingMs > 0 ? '+' : ''}${timingMs} ms) · ${targetName}`;
            cueKind = 'warn';
          }
          this.setGrade(t.id, grade);
          this.results.set(t.id, {
            target: t,
            grade,
            playedMidi: frame.midi,
            semitoneDiff: 0,
            timingMs,
            centsOff,
            cue,
          });
          this.provisionalWrong.delete(t.id);
          this.liveCue = cue;
          this.liveCueKind = cueKind;
        } else {
          const prev = this.provisionalWrong.get(t.id);
          if (!prev || Math.abs(semitoneDiff) < Math.abs(prev.semitoneDiff)) {
            this.provisionalWrong.set(t.id, {
              target: t,
              playedMidi: frame.midi,
              semitoneDiff,
              timingMs,
              centsOff,
            });
          }
          if (!activeWindowWrong) activeWindowWrong = { diff: semitoneDiff, targetName, label };
        }
      }
    }

    if (activeWindowWrong) {
      this.liveCue = describePitchCorrection(activeWindowWrong.diff, activeWindowWrong.targetName, activeWindowWrong.label);
      this.liveCueKind = 'miss';
    }

    return this.getSnapshot(this.findCurrentTarget(trackTime));
  }

  private computeCounts() {
    let hits = 0;
    let timingIssues = 0;
    let wrongNotes = 0;
    let missedNotes = 0;
    let timingSum = 0;
    let centsSum = 0;
    let matchedCount = 0;

    for (const r of this.results.values()) {
      if (r.grade === 'hit') hits += 1;
      else if (r.grade === 'timing') timingIssues += 1;
      else if (r.grade === 'wrong') wrongNotes += 1;
      else missedNotes += 1;

      if ((r.grade === 'hit' || r.grade === 'timing') && r.timingMs !== null && r.centsOff !== null) {
        timingSum += r.timingMs;
        centsSum += r.centsOff;
        matchedCount += 1;
      }
    }

    const evaluatedCount = this.results.size;
    const accuracy = evaluatedCount ? Math.round(((hits + 0.5 * timingIssues) / evaluatedCount) * 100) : null;
    const pitchAccuracy = evaluatedCount ? Math.round(((hits + timingIssues) / evaluatedCount) * 100) : null;
    const avgTimingMs = matchedCount ? Math.round(timingSum / matchedCount) : null;
    const avgCents = matchedCount ? Math.round(centsSum / matchedCount) : null;

    return { hits, timingIssues, wrongNotes, missedNotes, evaluatedCount, matchedCount, accuracy, pitchAccuracy, avgTimingMs, avgCents };
  }

  private buildTips(counts: ReturnType<BassCoachSession['computeCounts']>): CoachTip[] {
    const tips: CoachTip[] = [];

    // 1. Worst bar with wrong or missed notes.
    const barErrors = new Map<number, EvaluatedNote[]>();
    for (const r of this.results.values()) {
      if (r.grade === 'wrong' || r.grade === 'missed') {
        const list = barErrors.get(r.target.barIndex) ?? [];
        list.push(r);
        barErrors.set(r.target.barIndex, list);
      }
    }
    let worstBar = -1;
    let worstList: EvaluatedNote[] = [];
    for (const [b, list] of barErrors) {
      if (list.length > worstList.length || (list.length === worstList.length && b < worstBar)) {
        worstBar = b;
        worstList = list;
      }
    }
    if (worstBar >= 0 && worstList.length > 0) {
      const wrongOnes = worstList.filter((r) => r.grade === 'wrong' && r.semitoneDiff !== null);
      if (wrongOnes.length > 0) {
        const ex = wrongOnes[0];
        const targetName = midiToNoteName(ex.target.midi);
        const label = fretLabel(ex.target.string, ex.target.fret, this.strings);
        const diff = ex.semitoneDiff!;
        const detail =
          diff === 12
            ? `played 1 octave too high — play ${targetName} (${label})`
            : diff === -12
              ? `played 1 octave too low — play ${targetName} (${label})`
              : diff > 0
                ? `played ${diff} ${diff === 1 ? 'fret' : 'frets'} too high — play ${targetName} (${label})`
                : `played ${-diff} ${diff === -1 ? 'fret' : 'frets'} too low — play ${targetName} (${label})`;
        tips.push({
          id: `bar-${worstBar}`,
          kind: 'note',
          text: `Bar ${worstBar + 1}: ${detail}`,
          barIndex: worstBar,
        });
      } else {
        tips.push({
          id: `bar-${worstBar}`,
          kind: 'note',
          text: `Bar ${worstBar + 1}: missed ${worstList.length} ${worstList.length === 1 ? 'note' : 'notes'} — loop this bar to lock it in`,
          barIndex: worstBar,
        });
      }
    }

    // 2. Timing trend.
    if (counts.matchedCount >= 3 && counts.avgTimingMs !== null && Math.abs(counts.avgTimingMs) >= 45) {
      if (counts.avgTimingMs > 0) {
        tips.push({
          id: 'timing-late',
          kind: 'timing',
          text: `Dragging behind the beat (+${counts.avgTimingMs} ms) — anticipate attacks slightly`,
          suggestedSpeed: this.lastSpeed >= 0.9 ? 0.75 : undefined,
        });
      } else {
        tips.push({
          id: 'timing-early',
          kind: 'timing',
          text: `Rushing ahead of the beat (${counts.avgTimingMs} ms) — settle back into the pocket`,
        });
      }
    }

    // 3. Tuning / intonation trend.
    if (counts.matchedCount >= 3 && counts.avgCents !== null && Math.abs(counts.avgCents) >= 16) {
      tips.push({
        id: 'tuning',
        kind: 'tuning',
        text:
          counts.avgCents > 0
            ? `Running sharp (+${counts.avgCents}¢) — ease fretting pressure or tune down slightly`
            : `Running flat (${counts.avgCents}¢) — check tuning before the next pass`,
      });
    }

    // 4. Slow down suggestion when overall match is low at full speed.
    if (
      tips.length < 3 &&
      counts.evaluatedCount >= 6 &&
      counts.accuracy !== null &&
      counts.accuracy < 70 &&
      this.lastSpeed >= 0.9 &&
      !tips.some((t) => t.suggestedSpeed !== undefined)
    ) {
      tips.push({
        id: 'speed-down',
        kind: 'speed',
        text: `${counts.accuracy}% match at ${Math.round(this.lastSpeed * 100)}% — slow to 75% to build clean muscle memory`,
        suggestedSpeed: 0.75,
      });
    }

    // 5. Positive reinforcement when playing tightly.
    if (tips.length === 0 && counts.evaluatedCount >= 4 && counts.accuracy !== null && counts.accuracy >= 90) {
      tips.push({
        id: 'praise',
        kind: 'praise',
        text: `Tight groove (${counts.accuracy}% match, ${this.bestStreak} note streak) — ready for the full mix!`,
      });
    }

    return tips.slice(0, 3);
  }

  getSnapshot(currentTarget: CoachTargetNote | null = null): CoachSnapshot {
    const counts = this.computeCounts();
    return {
      grades: this.gradesSnapshot,
      evaluatedCount: counts.evaluatedCount,
      hits: counts.hits,
      timingIssues: counts.timingIssues,
      wrongNotes: counts.wrongNotes,
      missedNotes: counts.missedNotes,
      accuracy: counts.accuracy,
      pitchAccuracy: counts.pitchAccuracy,
      avgTimingMs: counts.avgTimingMs,
      avgCents: counts.avgCents,
      streak: this.streak,
      bestStreak: this.bestStreak,
      currentTarget,
      liveCue: this.liveCue,
      liveCueKind: this.liveCueKind,
      tips: this.buildTips(counts),
      passes: this.passes,
      bestPassAccuracy: this.bestPassAccuracy,
    };
  }
}
