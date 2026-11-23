import { expect, test } from '@playwright/test';
import { Metronome, metronomeGain, renderClick } from '../src/audio/metronome';

function makeFakeCtx() {
  const starts: number[] = [];
  const ctx = {
    sampleRate: 44100,
    currentTime: 0,
    createGain: () => ({ gain: { value: 1 }, connect: () => {} }),
    createBuffer: () => ({ copyToChannel: () => {} }),
    createBufferSource: () => ({ buffer: null, connect: () => {}, start: (at: number) => starts.push(at) }),
  };
  return { ctx: ctx as unknown as AudioContext, dest: {} as AudioNode, starts };
}

test('click is a short, peak-normalised tick', () => {
  const sr = 44100;
  const click = renderClick(sr);
  expect(click.length / sr).toBeLessThanOrEqual(0.05);
  const peak = click.reduce((m, x) => Math.max(m, Math.abs(x)), 0);
  expect(peak).toBeCloseTo(1, 5);
  // Almost all of the energy lands in the first 15 ms, so it reads as one sharp tick.
  const energy = (a: Float32Array) => a.reduce((s, x) => s + x * x, 0);
  expect(energy(click.subarray(0, Math.round(sr * 0.015))) / energy(click)).toBeGreaterThan(0.9);
});

test('metronome volume boosts above unity at the top of the slider', () => {
  expect(metronomeGain(0)).toBe(0);
  expect(metronomeGain(0.5)).toBeCloseTo(1, 5);
  expect(metronomeGain(1)).toBeCloseTo(4, 5);
  expect(metronomeGain(2)).toBeCloseTo(4, 5);
});

test('metronome wraps clicks seamlessly across loop boundaries over multiple cycles', () => {
  const { ctx, dest, starts } = makeFakeCtx();
  const m = new Metronome(ctx, dest);
  m.configure({ enabled: true, bpm: 120, offset: 0, volume: 0.7, beats: null, downbeat: 0 });
  const loop = { start: 1.0, end: 2.0 };
  const toCtx = (t: number) => t - 1.0;

  m.reset(1.0, 0);
  for (const now of [0, 0.5, 1.0, 1.5, 2.0]) {
    (ctx as { currentTime: number }).currentTime = now;
    m.schedule(toCtx, 10, loop);
  }
  expect(starts).toHaveLength(5);
  starts.forEach((s, i) => expect(s).toBeCloseTo(i * 0.5, 4));
});

test('metronome does not double-click when loop boundaries fall directly on tracked beats', () => {
  const { ctx, dest, starts } = makeFakeCtx();
  const m = new Metronome(ctx, dest);
  m.configure({ enabled: true, bpm: 120, offset: 0, volume: 0.7, beats: [0, 0.5, 1.0, 1.5, 2.0, 2.5], downbeat: 0 });
  const loop = { start: 0.5, end: 1.5 };
  const toCtx = (t: number) => t - 0.5;

  m.reset(0.5, 0);
  for (const now of [0, 0.5, 1.0, 1.5]) {
    (ctx as { currentTime: number }).currentTime = now;
    m.schedule(toCtx, 10, loop);
  }
  expect(starts).toHaveLength(4);
  starts.forEach((s, i) => expect(s).toBeCloseTo(i * 0.5, 4));
});

test('metronome safely handles a loop window containing zero beats', () => {
  const { ctx, dest, starts } = makeFakeCtx();
  const m = new Metronome(ctx, dest);
  m.configure({ enabled: true, bpm: 120, offset: 0, volume: 0.7, beats: [0, 2.0, 4.0], downbeat: 0 });
  m.reset(0.5, 0);
  m.schedule((t) => t, 10, { start: 0.5, end: 1.5 });
  expect(starts).toEqual([]);
});
