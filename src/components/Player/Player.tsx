import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';
import { detectBeats } from '../../audio/bpm';
import { beatGrid } from '../../audio/chords';
import { Engine, MIN_LOOP_DURATION } from '../../audio/Engine';
import { useEngineState, usePosition } from '../../audio/hooks';
import { clearAnalyses, isNumber, isNumberArray, readAnalysis, writeAnalysis } from '../../lib/analysisCache';
import { shareSong } from '../../lib/share';
import { stemMeta } from '../../lib/stemMeta';
import { toast } from '../../lib/toast';
import type { SongSource } from '../../lib/types';
import { barsFromBeats } from '../../lib/chordChart';
import { keyName } from '../../lib/chords';
import { installMode, onInstallChange, promptInstall } from '../../lib/install';
import { Footer } from '../Footer';
import { ChevronDownIcon, MoreVerticalIcon, ShareIcon, SlidersIcon } from '../icons';
import { BassPage } from './BassPage';
import { BassStrip } from './BassStrip';
import { ChordSheet } from './ChordSheet';
import { ChordStrip } from './ChordStrip';
import { DisplaySheet } from './DisplaySheet';
import { DrumSheet } from './DrumSheet';
import { DrumStrip } from './DrumStrip';
import { LoadingModal } from './LoadingModal';
import { barIndexAt, LoopBar, type LoopBarSpan } from './LoopBar';
import { MiniPlayer } from './MiniPlayer';
import { MetronomeSheet } from './MetronomeSheet';
import { PitchSpeedSheet } from './PitchSpeedSheet';
import { SeekBar } from './SeekBar';
import { MenuItem, Sheet } from './Sheet';
import { StemRow } from './StemRow';
import { Transport } from './Transport';
import { useBass } from './useBass';
import { useChords, type ChordsState } from './useChords';
import { useDrums } from './useDrums';
import type { BassStringCount } from '../../audio/bass';

type Panel = null | 'metronome' | 'pitch' | 'menu' | 'display' | 'install' | 'chords' | 'drums' | { stem: number };

function isBassViewUrl(): boolean {
  return new URLSearchParams(window.location.search).get('view') === 'bass';
}

interface CachedBeats {
  bpm: number;
  beats: number[];
  downbeat: number;
}

function isCachedBeats(value: unknown): value is CachedBeats {
  const b = value as Partial<CachedBeats> | null;
  return !!b && isNumber(b.bpm) && isNumberArray(b.beats) && b.beats.length > 0 && Number.isInteger(b.downbeat);
}

function readCachedBeats(id: string): CachedBeats | null {
  try {
    // Caches from before the rename to Mosaic (the old fixed-grid one could be badly off).
    localStorage.removeItem(`moise:bpm:${id}`);
    localStorage.removeItem(`moise:beats:v2:${id}`);
  } catch {
    // storage unavailable
  }
  return readAnalysis('beats', id, isCachedBeats);
}

function writeCachedBeats(id: string, value: CachedBeats) {
  // Millisecond precision is plenty and keeps the entry small.
  const beats = value.beats.map((b) => Math.round(b * 1000) / 1000);
  writeAnalysis('beats', id, { ...value, beats });
}

/** Per-viewer preference: waveforms behind the stem sliders (on unless switched off). */
const WAVES_KEY = 'mosaic:waveforms';

function readShowWaves(): boolean {
  try {
    return localStorage.getItem(WAVES_KEY) !== 'off';
  } catch {
    return true;
  }
}

function writeShowWaves(show: boolean) {
  try {
    if (show) localStorage.removeItem(WAVES_KEY);
    else localStorage.setItem(WAVES_KEY, 'off');
  } catch {
    // storage unavailable — the choice lasts for this session only
  }
}

/** Per-viewer preference: chord strip on top of the stems (on unless switched off). */
const CHORDS_KEY = 'mosaic:chords';

function readShowChords(): boolean {
  try {
    return localStorage.getItem(CHORDS_KEY) !== 'off';
  } catch {
    return true;
  }
}

function writeShowChords(show: boolean) {
  try {
    if (show) localStorage.removeItem(CHORDS_KEY);
    else localStorage.setItem(CHORDS_KEY, 'off');
  } catch {
    // storage unavailable — the choice lasts for this session only
  }
}

/** Per-viewer preference: drum groove strip under the chord strip (on unless switched off). */
const DRUMS_KEY = 'mosaic:drums';

function readShowDrums(): boolean {
  try {
    return localStorage.getItem(DRUMS_KEY) !== 'off';
  } catch {
    return true;
  }
}

function writeShowDrums(show: boolean) {
  try {
    if (show) localStorage.removeItem(DRUMS_KEY);
    else localStorage.setItem(DRUMS_KEY, 'off');
  } catch {
    // storage unavailable — the choice lasts for this session only
  }
}

/** Per-viewer preference: bass tab strip under the drum strip (on unless switched off). */
const BASS_KEY = 'mosaic:bass';

function readShowBass(): boolean {
  try {
    return localStorage.getItem(BASS_KEY) !== 'off';
  } catch {
    return true;
  }
}

function writeShowBass(show: boolean) {
  try {
    if (show) localStorage.removeItem(BASS_KEY);
    else localStorage.setItem(BASS_KEY, 'off');
  } catch {
    // storage unavailable — the choice lasts for this session only
  }
}

/** Per-viewer preference: 4-string (E-A-D-G) or 5-string (B-E-A-D-G) bass tab. */
const BASS_STRINGS_KEY = 'mosaic:bass-strings';

function readBassStrings(): BassStringCount {
  try {
    return localStorage.getItem(BASS_STRINGS_KEY) === '4' ? 4 : 5;
  } catch {
    return 5;
  }
}

function writeBassStrings(count: BassStringCount) {
  try {
    localStorage.setItem(BASS_STRINGS_KEY, String(count));
  } catch {
    // storage unavailable — the choice lasts for this session only
  }
}

/** Subtitle of the Key row in Pitch & speed: the original key, and where the pitch takes it. */
function keyLabel({ status, analysis }: ChordsState, pitch: number): string {
  if (status === 'analysing') return 'Detecting key…';
  const key = analysis?.key;
  if (!key) return 'semitones';
  return pitch ? `${keyName(key)} → ${keyName(key, pitch)}` : keyName(key);
}

export function Player({ song, onClose }: { song: SongSource; onClose: () => void }) {
  const [engine, setEngine] = useState<Engine | null>(null);

  useEffect(() => {
    const e = new Engine(song);
    setEngine(e);
    // Test/debug hook used by the Playwright suite.
    (window as unknown as { __mosaicEngine?: Engine }).__mosaicEngine = e;
    return () => e.dispose();
  }, [song]);

  if (!engine) return <div className="screen player" />;
  return <PlayerView engine={engine} song={song} onClose={onClose} />;
}

function PlayerView({ engine, song, onClose }: { engine: Engine; song: SongSource; onClose: () => void }) {
  const state = useEngineState(engine);
  const position = usePosition(engine, state.playing);
  const [panel, setPanel] = useState<Panel>(null);
  const [bassPage, setBassPage] = useState(isBassViewUrl);
  const closingBassRef = useRef(false);
  const install = useSyncExternalStore(onInstallChange, installMode);
  const [showWaves, setShowWaves] = useState(readShowWaves);
  const [showChords, setShowChords] = useState(readShowChords);
  const [showDrums, setShowDrums] = useState(readShowDrums);
  const [showBass, setShowBass] = useState(readShowBass);
  const [bassStrings, setBassStrings] = useState<BassStringCount>(readBassStrings);
  const chooseBassStrings = useCallback((count: BassStringCount) => {
    writeBassStrings(count);
    setBassStrings(count);
  }, []);
  // While the seek bar is dragged, the waveform highlight follows the drag, not the playhead.
  const [scrub, setScrub] = useState<number | null>(null);
  // Bumped by Re-analyse song: the chords and drums start a new job.
  const [run, setRun] = useState(0);
  const shown = scrub ?? position;
  const closePanel = useCallback(() => setPanel(null), []);
  // Docked in the sheets and BassPage so playback stays one tap away.
  const dock = <MiniPlayer engine={engine} state={state} position={position} scrub={scrub} onScrub={setScrub} />;

  useEffect(() => {
    closingBassRef.current = false;
  }, [bassPage]);

  useEffect(() => {
    const onPop = () => setBassPage(isBassViewUrl());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const openBassPage = useCallback(() => {
    setPanel(null);
    if (!isBassViewUrl()) {
      const url = new URL(window.location.href);
      url.searchParams.set('view', 'bass');
      history.pushState({ ...history.state, bassPage: true }, '', url.toString());
    }
    setBassPage(true);
  }, []);

  const closeBassPage = useCallback(() => {
    if (closingBassRef.current) return;
    if (!isBassViewUrl()) {
      setBassPage(false);
      return;
    }
    if (history.state?.bassPage) {
      closingBassRef.current = true;
      history.back();
    } else {
      const url = new URL(window.location.href);
      url.searchParams.delete('view');
      history.replaceState(history.state, '', url.toString());
      setBassPage(false);
    }
  }, []);

  const runDetection = useCallback(async () => {
    engine.setMetronome({ detecting: true });
    try {
      const buffer = engine.tempoBuffer();
      if (!buffer) throw new Error('No audio to analyse');
      const result = await detectBeats(buffer);
      engine.setMetronome({ ...result, offset: 0, detecting: false });
      if (song.shareable) writeCachedBeats(song.id, result);
    } catch (e) {
      console.warn('Beat detection failed', e);
      engine.setMetronome({ detecting: false });
      toast("Couldn't detect the tempo — set it manually");
    }
  }, [engine, song]);

  // Beats: songs.json fixed tempo override → cached tracking → track now.
  useEffect(() => {
    if (state.status !== 'ready' || song.bpm) return;
    const cached = song.shareable ? readCachedBeats(song.id) : null;
    if (cached) engine.setMetronome({ ...cached, offset: 0 });
    else void runDetection();
  }, [state.status]);

  // After the beats effect above, so it sees beats it just set or a detection it just started.
  const chords = useChords(engine, song, state, run);
  const drums = useDrums(engine, song, state, run);
  const bass = useBass(engine, song, state, drums, run);

  // Forget this song's cached beats, chords and drums and work them out again from the decoded stems.
  const reanalyse = () => {
    clearAnalyses(song.id);
    // Starts the beat tracker first, so the new chord and drum jobs wait for its beats.
    if (!song.bpm) void runDetection();
    setRun((r) => r + 1);
  };
  const seek = useCallback((t: number) => engine.seek(t), [engine]);

  // Bars for the chord chart: the drum transcription's (its meter and downbeat), else the metronome's beats in 4/4.
  const { beats, downbeat, bpm, offset } = state.metronome;
  const chordBars = useMemo(() => {
    if (drums.analysis?.bars.length) return { bars: drums.analysis.bars, meter: drums.analysis.meter };
    const grid = beats ?? beatGrid(bpm, offset, state.duration);
    return { bars: barsFromBeats(grid, beats ? downbeat : 0, 4, state.duration), meter: 4 };
  }, [drums.analysis, beats, downbeat, bpm, offset, state.duration]);

  // Keyboard shortcuts.
  const shortcutRef = useRef<{ bassPage: boolean; bassBars?: LoopBarSpan[]; fallbackBars: LoopBarSpan[] }>({
    bassPage,
    bassBars: bass.analysis?.bars,
    fallbackBars: chordBars.bars,
  });
  shortcutRef.current = { bassPage, bassBars: bass.analysis?.bars, fallbackBars: chordBars.bars };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if ((e.target instanceof HTMLInputElement && e.target.type !== 'range') || e.target instanceof HTMLTextAreaElement) return;
      if (e.code === 'Space') {
        e.preventDefault();
        engine.toggle();
      } else if (e.code === 'ArrowLeft' && !(e.target instanceof HTMLInputElement)) engine.skip(-5);
      else if (e.code === 'ArrowRight' && !(e.target instanceof HTMLInputElement)) engine.skip(5);
      else if (e.key === '[' || e.key === ']') {
        const { bassPage: inBass, bassBars } = shortcutRef.current;
        const pos = engine.position;
        if (inBass && bassBars?.length) {
          const idx = barIndexAt(bassBars, pos);
          if (e.key === '[') engine.setLoopA(bassBars[idx].start);
          else {
            const curA = engine.state.loop.start;
            if (curA !== null && bassBars[idx].end <= curA + 0.05) {
              const aIdx = barIndexAt(bassBars, curA + 1e-3);
              engine.setLoop(bassBars[idx].start, bassBars[Math.max(idx, aIdx)].end, { enabled: true });
            } else engine.setLoopB(bassBars[idx].end);
          }
        } else if (e.key === '[') engine.setLoopA(pos);
        else engine.setLoopB(pos);
      } else if (e.key === 'l' || e.key === 'L') {
        const { loop, duration } = engine.state;
        if (loop.start !== null && loop.end !== null) {
          engine.toggleLoop();
          return;
        }
        const { bassPage: inBass, bassBars, fallbackBars } = shortcutRef.current;
        const bars = inBass && bassBars?.length ? bassBars : bassBars?.length ? bassBars : fallbackBars;
        const pos = engine.position;
        if (loop.start !== null) {
          if (inBass && bassBars?.length) {
            const aIdx = barIndexAt(bassBars, loop.start + 1e-3);
            const curIdx = barIndexAt(bassBars, pos);
            engine.setLoop(bassBars[aIdx].start, bassBars[Math.max(aIdx, curIdx)].end, { enabled: true });
          } else if (pos > loop.start + MIN_LOOP_DURATION) engine.setLoopB(pos);
          else engine.setLoop(loop.start, Math.min(duration, loop.start + 8), { enabled: true });
        } else if (bars.length) {
          const idx = barIndexAt(bars, pos);
          engine.setLoop(bars[idx].start, bars[idx].end, { enabled: true });
        } else {
          const start = Math.max(0, Math.min(pos, Math.max(0, duration - 8)));
          const end = Math.min(duration, start + 8);
          if (end - start >= MIN_LOOP_DURATION) engine.setLoop(start, end, { enabled: true });
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [engine]);

  if (bassPage && state.status === 'ready') {
    return (
      <BassPage
        title={song.name}
        slug={song.id}
        engine={engine}
        stems={state.stems}
        analysis={bass.analysis}
        status={bass.status}
        chords={chords.analysis}
        bpm={state.metronome.bpm}
        pitch={state.pitch}
        strings={bassStrings}
        onStringsChange={chooseBassStrings}
        loop={state.loop}
        duration={state.duration}
        position={shown}
        playing={state.playing}
        speed={state.speed}
        bassBoost={state.bassBoost}
        onSeek={seek}
        onClose={closeBassPage}
        dock={dock}
      />
    );
  }

  return (
    <div className="screen player">
      <header className="player__header">
        <button type="button" className="icon-button" aria-label="Back to songs" onClick={onClose}>
          <ChevronDownIcon size={30} />
        </button>
        <h1 className="player__title" title={song.name}>
          {song.name}
        </h1>
        <button type="button" className="icon-button" aria-label="Strips and bass options" onClick={() => setPanel('display')}>
          <SlidersIcon size={24} />
        </button>
        <button type="button" className="icon-button" aria-label="Share" onClick={() => shareSong(song)}>
          <ShareIcon size={28} />
        </button>
        <button type="button" className="icon-button" aria-label="More options" onClick={() => setPanel('menu')}>
          <MoreVerticalIcon size={26} />
        </button>
      </header>

      {state.status === 'loading' && <LoadingModal songName={song.name} state={state} />}
      {state.status === 'error' && (
        <div className="modal-backdrop">
          <div className="modal modal--error" role="alertdialog" aria-modal="true" aria-label="Error">
            <p className="modal__title">{state.error}</p>
            <button type="button" className="pill-button" onClick={onClose}>
              Back
            </button>
          </div>
        </div>
      )}

      {showChords && (
        <ChordStrip chords={chords} position={shown} pitch={state.pitch} onOpen={() => setPanel('chords')} onKey={() => setPanel('pitch')} />
      )}
      {showDrums && (
        <DrumStrip drums={drums} position={shown} bpm={state.metronome.bpm} onOpen={() => setPanel('drums')} onTempo={() => setPanel('metronome')} />
      )}
      {showBass && <BassStrip bass={bass} position={shown} pitch={state.pitch} strings={bassStrings} loop={state.loop} onOpen={openBassPage} />}

      <div className="stems" style={{ '--progress': `${state.duration ? (shown / state.duration) * 100 : 0}%` } as CSSProperties}>
        {state.stems.map((_, i) => (
          <StemRow key={i} engine={engine} stems={state.stems} index={i} showWave={showWaves} onMenu={() => setPanel({ stem: i })} />
        ))}
      </div>

      <div className="player__bottom">
        <SeekBar engine={engine} state={state} position={position} scrub={scrub} onScrub={setScrub} />
        <LoopBar
          engine={engine}
          loop={state.loop}
          position={shown}
          duration={state.duration}
          disabled={state.status !== 'ready'}
          bars={bass.analysis?.bars ?? chordBars.bars}
          speed={state.speed}
          showSpeed={state.loop.enabled}
        />
        <Transport engine={engine} state={state} onMetronome={() => setPanel('metronome')} onPitch={() => setPanel('pitch')} />
        <Footer />
      </div>

      {panel === 'metronome' && <MetronomeSheet engine={engine} state={state} onClose={closePanel} onDetect={runDetection} dock={dock} />}
      {panel === 'pitch' && <PitchSpeedSheet engine={engine} state={state} keyLabel={keyLabel(chords, state.pitch)} onClose={closePanel} dock={dock} />}
      {panel === 'chords' && chords.analysis && (
        <ChordSheet
          analysis={chords.analysis}
          bars={chordBars.bars}
          meter={chordBars.meter}
          position={shown}
          pitch={state.pitch}
          onSeek={seek}
          onClose={closePanel}
          dock={dock}
        />
      )}
      {panel === 'drums' && drums.analysis && <DrumSheet title={song.name} analysis={drums.analysis} position={shown} onSeek={seek} onClose={closePanel} dock={dock} />}
      {panel === 'display' && (
        <DisplaySheet
          showChords={showChords}
          onToggleChords={() => {
            writeShowChords(!showChords);
            setShowChords(!showChords);
          }}
          showDrums={showDrums}
          onToggleDrums={() => {
            writeShowDrums(!showDrums);
            setShowDrums(!showDrums);
          }}
          showBass={showBass}
          onToggleBass={() => {
            writeShowBass(!showBass);
            setShowBass(!showBass);
          }}
          showWaves={showWaves}
          onToggleWaves={() => {
            writeShowWaves(!showWaves);
            setShowWaves(!showWaves);
          }}
          bassStrings={bassStrings}
          onBassStringsChange={chooseBassStrings}
          dock={dock}
          onClose={closePanel}
        />
      )}
      {panel === 'menu' && (
        <Sheet title={song.name} onClose={closePanel}>
          {install && (
            <MenuItem
              onClick={() => {
                if (install === 'prompt') {
                  closePanel();
                  void promptInstall();
                } else {
                  setPanel('install');
                }
              }}
            >
              {install === 'prompt' ? 'Install app' : 'Add to Home Screen'}
            </MenuItem>
          )}
          {song.shareable && (
            <MenuItem
              onClick={() => {
                closePanel();
                void shareSong(song);
              }}
            >
              Copy share link
            </MenuItem>
          )}
          <MenuItem onClick={() => setPanel('display')}>Strips &amp; bass</MenuItem>
          <MenuItem
            onClick={() => {
              writeShowWaves(!showWaves);
              setShowWaves(!showWaves);
              closePanel();
            }}
          >
            {showWaves ? 'Hide waveforms' : 'Show waveforms'}
          </MenuItem>
          <MenuItem
            onClick={() => {
              writeShowChords(!showChords);
              setShowChords(!showChords);
              closePanel();
            }}
          >
            {showChords ? 'Hide chords' : 'Show chords'}
          </MenuItem>
          <MenuItem
            onClick={() => {
              writeShowDrums(!showDrums);
              setShowDrums(!showDrums);
              closePanel();
            }}
          >
            {showDrums ? 'Hide drums' : 'Show drums'}
          </MenuItem>
          <MenuItem
            onClick={() => {
              writeShowBass(!showBass);
              setShowBass(!showBass);
              closePanel();
            }}
          >
            {showBass ? 'Hide bass tab' : 'Show bass tab'}
          </MenuItem>
          <MenuItem
            onClick={() => {
              engine.resetMix();
              closePanel();
            }}
          >
            Reset mix
          </MenuItem>
          {song.shareable && (
            <MenuItem
              onClick={() => {
                closePanel();
                reanalyse();
              }}
            >
              Re-analyse song
            </MenuItem>
          )}
          <MenuItem onClick={onClose}>Back to songs</MenuItem>
        </Sheet>
      )}
      {panel === 'install' && install === 'ios' && (
        <Sheet title="Install Mosaic" onClose={closePanel}>
          <p className="install__hint">
            Tap <ShareIcon size={15} className="install__share" aria-label="Share" role="img" aria-hidden={false} /> then{' '}
            <strong>Add to Home Screen</strong> to install Mosaic.
          </p>
        </Sheet>
      )}
      {typeof panel === 'object' && panel !== null && (
        <Sheet title={stemMeta(state.stems[panel.stem].name).label} onClose={closePanel}>
          <MenuItem onClick={() => engine.toggleSolo(panel.stem)}>
            {Engine.isSolo(state.stems, panel.stem) ? 'Unmute all' : 'Solo'}
          </MenuItem>
          <MenuItem active={state.stems[panel.stem].muted} onClick={() => engine.toggleMute(panel.stem)}>
            Mute
          </MenuItem>
          <MenuItem
            onClick={() => {
              engine.resetStem(panel.stem);
              closePanel();
            }}
          >
            Reset volume
          </MenuItem>
        </Sheet>
      )}
    </div>
  );
}
