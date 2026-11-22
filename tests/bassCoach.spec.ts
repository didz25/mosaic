import { expect, test } from '@playwright/test';
import type { BassBar } from '../src/audio/bass';
import { BassCoachSession, detectLiveBassPitch, type LivePitchFrame } from '../src/audio/bassCoach';

function synthTone(freq: number, sr: number, len = 4096, harmonics = [1]): Float32Array {
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    let s = 0;
    for (let h = 0; h < harmonics.length; h++) {
      s += harmonics[h] * Math.sin((2 * Math.PI * freq * (h + 1) * i) / sr);
    }
    out[i] = s * 0.4;
  }
  return out;
}

function makeFrame(midi: number | null, opts?: { cents?: number; rms?: number; isOnset?: boolean }): LivePitchFrame {
  if (midi === null) {
    return { rms: opts?.rms ?? 0, freq: null, midiFloat: null, midi: null, cents: 0, noteName: null, clarity: 0, isOnset: false };
  }
  const cents = opts?.cents ?? 0;
  const midiFloat = midi + cents / 100;
  const freq = 440 * Math.pow(2, (midiFloat - 69) / 12);
  return {
    rms: opts?.rms ?? 0.2,
    freq,
    midiFloat,
    midi,
    cents,
    noteName: 'N',
    clarity: 0.95,
    isOnset: opts?.isOnset ?? true,
  };
}

function makeTestBars(): BassBar[] {
  return [
    {
      start: 0,
      end: 2,
      beats: [0, 0.5, 1, 1.5],
      kind: 'riff',
      riff: 0,
      repeat: false,
      notes: [
        { step: 0, midi: 28, string: 3, fret: 0, duration: 4, velocity: 0.9 },
        { step: 4, midi: 33, string: 2, fret: 0, duration: 4, velocity: 0.9 },
        { step: 8, midi: 35, string: 2, fret: 2, duration: 4, velocity: 0.9 },
        { step: 12, midi: 36, string: 2, fret: 3, duration: 4, velocity: 0.9 },
      ],
    },
    {
      start: 2,
      end: 4,
      beats: [2, 2.5, 3, 3.5],
      kind: 'riff',
      riff: 0,
      repeat: true,
      notes: [
        { step: 0, midi: 28, string: 3, fret: 0, duration: 4, velocity: 0.9 },
        { step: 4, midi: 33, string: 2, fret: 0, duration: 4, velocity: 0.9 },
      ],
    },
  ];
}

test('detectLiveBassPitch detects B0 to G3 on both pure sines and weak-fundamental bass tones', () => {
  const sr = 48000;
  // Low B0 (MIDI 23, 30.87 Hz) with weak fundamental and strong 2nd/3rd harmonics.
  const b0 = detectLiveBassPitch(synthTone(30.8677, sr, 4096, [0.25, 0.9, 0.55]), sr);
  expect(b0.midi).toBe(23);
  expect(b0.noteName).toBe('B0');

  // E1 (MIDI 28, 41.20 Hz) weak fundamental.
  const e1 = detectLiveBassPitch(synthTone(41.2034, sr, 4096, [0.25, 0.9, 0.55]), sr);
  expect(e1.midi).toBe(28);
  expect(e1.noteName).toBe('E1');

  // Pure sine A2 (MIDI 45, 110 Hz) must not drop an octave.
  const a2 = detectLiveBassPitch(synthTone(110, sr, 4096, [1]), sr);
  expect(a2.midi).toBe(45);
  expect(a2.noteName).toBe('A2');

  // G3 (MIDI 55, 196 Hz) pure sine.
  const g3 = detectLiveBassPitch(synthTone(196, sr, 4096, [1]), sr);
  expect(g3.midi).toBe(55);
  expect(g3.noteName).toBe('G3');
});

test('detectLiveBassPitch measures sharp/flat cents and rejects silence or white noise', () => {
  const sr = 44100;
  const sharpHz = 41.2034 * Math.pow(2, 25 / 1200);
  const sharp = detectLiveBassPitch(synthTone(sharpHz, sr, 4096, [0.6, 0.4]), sr);
  expect(sharp.midi).toBe(28);
  expect(sharp.cents).toBeGreaterThanOrEqual(20);
  expect(sharp.cents).toBeLessThanOrEqual(30);

  const flatHz = 55 * Math.pow(2, -22 / 1200);
  const flat = detectLiveBassPitch(synthTone(flatHz, sr, 4096, [0.6, 0.4]), sr);
  expect(flat.midi).toBe(33);
  expect(flat.cents).toBeLessThanOrEqual(-17);
  expect(flat.cents).toBeGreaterThanOrEqual(-27);

  const silence = new Float32Array(4096);
  expect(detectLiveBassPitch(silence, sr).midi).toBeNull();

  const noise = new Float32Array(4096);
  let seed = 42;
  for (let i = 0; i < noise.length; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    noise[i] = ((seed / 0xffffffff) - 0.5) * 0.4;
  }
  expect(detectLiveBassPitch(noise, sr).midi).toBeNull();
});

test('BassCoachSession grades perfect playing as 100% hit with praise tip', () => {
  const bars = makeTestBars();
  const session = new BassCoachSession(bars, 4, 5);
  const times = [
    { t: 0, midi: 28 },
    { t: 0.5, midi: 33 },
    { t: 1.0, midi: 35 },
    { t: 1.5, midi: 36 },
  ];
  let snap = session.getSnapshot();
  for (const ev of times) {
    snap = session.update(makeFrame(ev.midi), ev.t, { playing: true, speed: 1, latencyMs: 0, strings: 5 });
  }
  expect(snap.evaluatedCount).toBe(4);
  expect(snap.hits).toBe(4);
  expect(snap.accuracy).toBe(100);
  expect(snap.pitchAccuracy).toBe(100);
  expect(snap.streak).toBe(4);
  expect(snap.tips.some((t) => t.kind === 'praise')).toBe(true);
});

test('BassCoachSession reports wrong frets, octave errors, timing drift, and tuning issues', () => {
  const bars = makeTestBars();

  // Wrong fret (+2 semitones) on bar 1 note 1, rest hit.
  const wrongSession = new BassCoachSession(bars, 4, 5);
  wrongSession.update(makeFrame(30), 0.02, { playing: true, speed: 1, latencyMs: 0, strings: 5 });
  wrongSession.update(makeFrame(null), 0.3, { playing: true, speed: 1, latencyMs: 0, strings: 5 });
  const wrongSnap = wrongSession.update(makeFrame(33), 0.5, { playing: true, speed: 1, latencyMs: 0, strings: 5 });
  expect(wrongSnap.grades.get('0:0')).toBe('wrong');
  expect(wrongSnap.tips[0]?.barIndex).toBe(0);
  expect(wrongSnap.tips[0]?.text).toContain('2 frets too high');

  // Octave error (+12 semitones).
  const octSession = new BassCoachSession(bars, 4, 5);
  octSession.update(makeFrame(40), 0.0, { playing: true, speed: 1, latencyMs: 0, strings: 5 });
  const octSnap = octSession.update(makeFrame(null), 0.3, { playing: true, speed: 1, latencyMs: 0, strings: 5 });
  expect(octSnap.grades.get('0:0')).toBe('wrong');
  expect(octSnap.tips[0]?.text).toContain('1 octave too high');

  // Consistently late (+140 ms) triggers timing trend and suggestedSpeed.
  const lateSession = new BassCoachSession(bars, 4, 5);
  let lateSnap = lateSession.getSnapshot();
  for (const [t, midi] of [
    [0.14, 28],
    [0.64, 33],
    [1.14, 35],
    [1.64, 36],
  ] as const) {
    lateSnap = lateSession.update(makeFrame(midi), t, { playing: true, speed: 1, latencyMs: 0, strings: 5 });
  }
  expect(lateSnap.timingIssues).toBe(4);
  expect(lateSnap.avgTimingMs).toBeGreaterThanOrEqual(130);
  expect(lateSnap.tips.some((t) => t.kind === 'timing' && t.suggestedSpeed === 0.75)).toBe(true);

  // Consistently sharp (+24 cents) triggers tuning tip.
  const sharpSession = new BassCoachSession(bars, 4, 5);
  let sharpSnap = sharpSession.getSnapshot();
  for (const [t, midi] of [
    [0, 28],
    [0.5, 33],
    [1.0, 35],
  ] as const) {
    sharpSnap = sharpSession.update(makeFrame(midi, { cents: 24 }), t, { playing: true, speed: 1, latencyMs: 0, strings: 5 });
  }
  expect(sharpSnap.avgCents).toBe(24);
  expect(sharpSnap.tips.some((t) => t.kind === 'tuning' && t.text.includes('sharp'))).toBe(true);
});

test('BassCoachSession skips earlier bars on mid-song start, compensates latency, and archives loop passes', () => {
  const bars = makeTestBars();
  const session = new BassCoachSession(bars, 4, 5);

  // Starting playback at bar 2 (t = 2.0) must not mark bar 1 notes as missed.
  let snap = session.update(makeFrame(28), 2.1, { playing: true, speed: 1, latencyMs: 100, strings: 5 });
  expect(snap.grades.has('0:0')).toBe(false);
  expect(snap.grades.get('1:0')).toBe('hit'); // 2.1 - 0.1 latency = 2.0 -> 0 ms offset!
  expect(snap.missedNotes).toBe(0);

  snap = session.update(makeFrame(33), 2.6, { playing: true, speed: 1, latencyMs: 100, strings: 5 });
  expect(snap.grades.get('1:4')).toBe('hit');
  expect(snap.accuracy).toBe(100);

  // Loop wrap back to t = 2.0 archives Pass 1 (100%) and resets grades for Pass 2.
  snap = session.update(makeFrame(null), 2.0, { playing: true, speed: 1, latencyMs: 100, strings: 5 });
  expect(snap.passes).toHaveLength(1);
  expect(snap.passes[0].accuracy).toBe(100);
  expect(snap.bestPassAccuracy).toBe(100);
  expect(snap.grades.size).toBe(0);
  expect(snap.evaluatedCount).toBe(0);
});
