import { useCallback, useEffect, useRef, useState } from 'react';
import type { BassBar, BassStringCount } from '../../audio/bass';
import { BassCoachSession, detectLiveBassPitch, type CoachSnapshot, type LivePitchFrame } from '../../audio/bassCoach';

const LATENCY_KEY = 'mosaic:bass-coach-latency';
const SAMPLE_INTERVAL_MS = 33;

const EMPTY_FRAME: LivePitchFrame = {
  rms: 0,
  freq: null,
  midiFloat: null,
  midi: null,
  cents: 0,
  noteName: null,
  clarity: 0,
  isOnset: false,
};

function readLatency(): number {
  try {
    const raw = Number(localStorage.getItem(LATENCY_KEY));
    return Number.isFinite(raw) ? Math.max(-150, Math.min(150, Math.round(raw))) : 0;
  } catch {
    return 0;
  }
}

function writeLatency(ms: number) {
  try {
    localStorage.setItem(LATENCY_KEY, String(ms));
  } catch {
    // storage unavailable
  }
}

function friendlyMicError(err: unknown): string {
  const name = err instanceof Error ? err.name : '';
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
    return 'Microphone permission denied — allow access in your browser to listen to your bass.';
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return 'No microphone or bass audio interface found.';
  }
  if (name === 'NotReadableError' || name === 'TrackStartError') {
    return 'Audio input is busy in another app — close it and try again.';
  }
  return "Couldn't start listening to your audio input.";
}

export interface BassCoachControls {
  listening: boolean;
  starting: boolean;
  error: string | null;
  devices: MediaDeviceInfo[];
  deviceId: string;
  latencyMs: number;
  frame: LivePitchFrame;
  snapshot: CoachSnapshot;
  start: (overrideDeviceId?: string) => Promise<void>;
  stop: () => void;
  toggle: () => void;
  setDeviceId: (id: string) => void;
  setLatencyMs: (ms: number) => void;
  resetStats: () => void;
  dismissError: () => void;
}

/**
 * Captures live bass audio from a microphone or audio interface via getUserMedia + AnalyserNode
 * (never routed to speakers) and feeds pitch frames into BassCoachSession at ~30 fps.
 */
export function useBassCoach({
  bars,
  division,
  strings,
  position,
  playing,
  speed,
}: {
  bars: BassBar[];
  division: 3 | 4;
  strings: BassStringCount;
  position: number;
  playing: boolean;
  speed: number;
}): BassCoachControls {
  const sessionRef = useRef<BassCoachSession | null>(null);
  if (!sessionRef.current) sessionRef.current = new BassCoachSession(bars, division, strings);

  const [listening, setListening] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceIdState] = useState('');
  const [latencyMs, setLatencyState] = useState(readLatency);
  const [frame, setFrame] = useState<LivePitchFrame>(EMPTY_FRAME);
  const [snapshot, setSnapshot] = useState<CoachSnapshot>(() => sessionRef.current!.getSnapshot());

  const liveRef = useRef({ position, playing, speed, strings, latencyMs });
  liveRef.current = { position, playing, speed, strings, latencyMs };

  const audioRef = useRef<{
    ctx: AudioContext;
    stream: MediaStream;
    source: MediaStreamAudioSourceNode;
    analyser: AnalyserNode;
    buf: Float32Array<ArrayBuffer>;
    raf: number;
    lastTick: number;
    prevRms: number;
    prevMidi: number | null;
  } | null>(null);

  useEffect(() => {
    sessionRef.current?.setBars(bars, division, strings);
    setSnapshot(sessionRef.current!.getSnapshot());
  }, [bars, division, strings]);

  const teardownAudio = useCallback(() => {
    const a = audioRef.current;
    if (!a) return;
    cancelAnimationFrame(a.raf);
    a.source.disconnect();
    a.analyser.disconnect();
    a.stream.getTracks().forEach((t) => t.stop());
    void a.ctx.close();
    audioRef.current = null;
  }, []);

  const stop = useCallback(() => {
    teardownAudio();
    setListening(false);
    setStarting(false);
    setFrame(EMPTY_FRAME);
  }, [teardownAudio]);

  useEffect(() => teardownAudio, [teardownAudio]);

  const start = useCallback(
    async (overrideDeviceId?: string) => {
      const targetDevice = overrideDeviceId ?? deviceId;
      if (!navigator.mediaDevices?.getUserMedia) {
        setError('Audio input capture is unavailable in this browser.');
        return;
      }
      teardownAudio();
      setError(null);
      setStarting(true);
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            deviceId: targetDevice ? { exact: targetDevice } : undefined,
            // Voice DSP strips 30-120 Hz bass fundamentals, so disable all three.
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
          },
        });
        const ctx = new AudioContext({ latencyHint: 'interactive' });
        await ctx.resume();
        const source = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = ctx.sampleRate > 64000 ? 8192 : 4096;
        analyser.smoothingTimeConstant = 0;
        // Connect ONLY to AnalyserNode, never ctx.destination (avoids speaker feedback).
        source.connect(analyser);

        const buf = new Float32Array(new ArrayBuffer(analyser.fftSize * 4));
        const state = {
          ctx,
          stream,
          source,
          analyser,
          buf,
          raf: 0,
          lastTick: 0,
          prevRms: 0,
          prevMidi: null as number | null,
        };
        audioRef.current = state;

        if (navigator.mediaDevices.enumerateDevices) {
          void navigator.mediaDevices.enumerateDevices().then((all) => {
            if (audioRef.current !== state) return;
            setDevices(all.filter((d) => d.kind === 'audioinput'));
          });
        }

        const loop = (now: number) => {
          if (audioRef.current !== state) return;
          if (now - state.lastTick >= SAMPLE_INTERVAL_MS) {
            state.lastTick = now;
            state.analyser.getFloatTimeDomainData(state.buf);
            const nextFrame = detectLiveBassPitch(state.buf, state.ctx.sampleRate, {
              prevRms: state.prevRms,
              prevMidi: state.prevMidi,
            });
            state.prevRms = nextFrame.rms;
            state.prevMidi = nextFrame.midi;
            const cur = liveRef.current;
            const nextSnap = sessionRef.current!.update(nextFrame, cur.position, {
              playing: cur.playing,
              speed: cur.speed,
              latencyMs: cur.latencyMs,
              strings: cur.strings,
            });
            setFrame(nextFrame);
            setSnapshot(nextSnap);
          }
          state.raf = requestAnimationFrame(loop);
        };

        setListening(true);
        setStarting(false);
        state.raf = requestAnimationFrame(loop);
      } catch (e) {
        teardownAudio();
        setListening(false);
        setStarting(false);
        setError(friendlyMicError(e));
      }
    },
    [deviceId, teardownAudio],
  );

  const toggle = useCallback(() => {
    if (listening || starting) stop();
    else void start();
  }, [listening, starting, stop, start]);

  const setDeviceId = useCallback(
    (id: string) => {
      setDeviceIdState(id);
      if (listening) void start(id);
    },
    [listening, start],
  );

  const setLatencyMs = useCallback((ms: number) => {
    const clamped = Math.max(-150, Math.min(150, Math.round(ms)));
    writeLatency(clamped);
    setLatencyState(clamped);
  }, []);

  const resetStats = useCallback(() => {
    sessionRef.current?.reset();
    setSnapshot(sessionRef.current!.getSnapshot());
  }, []);

  const dismissError = useCallback(() => setError(null), []);

  return {
    listening,
    starting,
    error,
    devices,
    deviceId,
    latencyMs,
    frame,
    snapshot,
    start,
    stop,
    toggle,
    setDeviceId,
    setLatencyMs,
    resetStats,
    dismissError,
  };
}
