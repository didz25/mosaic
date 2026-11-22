import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { assignBassFingering, bassRoadMap, type BassAnalysis, type BassBar, type BassStringCount } from '../../audio/bass';
import type { NoteGrade } from '../../audio/bassCoach';
import type { ChordAnalysis } from '../../audio/chords';
import { Engine, type LoopState, type StemState } from '../../audio/Engine';
import { downloadBassTabMarkdown, formatBassTabMarkdown, formatBassTabText } from '../../lib/bassTab';
import { chordChart, type ChartBar } from '../../lib/chordChart';
import { stemMeta } from '../../lib/stemMeta';
import { toast } from '../../lib/toast';
import { ChevronDownIcon, ChevronLeftIcon, LoopIcon, MicIcon } from '../icons';
import { BassCoachPanel } from './BassCoachPanel';
import { BassScore } from './BassScore';
import { MiniTab } from './BassStrip';
import { BARS_PER_SYSTEM, BassTabSystem } from './BassTab';
import { LoopBar } from './LoopBar';
import { segmentAt, useStarts } from './timeline';
import type { BassState } from './useBass';
import { useBassCoach } from './useBassCoach';

type View = 'tab' | 'ascii';

const VIEW_KEY = 'mosaic:bass-view';

function readView(): View {
  try {
    return localStorage.getItem(VIEW_KEY) === 'ascii' ? 'ascii' : 'tab';
  } catch {
    return 'tab';
  }
}

function writeView(value: View) {
  try {
    localStorage.setItem(VIEW_KEY, value);
  } catch {
    // storage unavailable — the choice lasts for this session only
  }
}

function getBarsPerSystem(): number {
  if (typeof window === 'undefined') return BARS_PER_SYSTEM;
  const w = window.innerWidth;
  if (w >= 1600) return 5;
  if (w >= 1100) return 4;
  if (w >= 768) return 3;
  return BARS_PER_SYSTEM;
}

function useBarsPerSystem(): number {
  const [count, setCount] = useState(getBarsPerSystem);
  useEffect(() => {
    const onResize = () => {
      const next = getBarsPerSystem();
      setCount((prev) => (prev === next ? prev : next));
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return count;
}

function stepAt(bar: BassBar, t: number, division: number): number {
  let j = 0;
  while (j + 1 < bar.beats.length && bar.beats[j + 1] <= t) j++;
  const end = bar.beats[j + 1] ?? bar.end;
  const u = Math.min(0.999, Math.max(0, (t - bar.beats[j]) / (end - bar.beats[j])));
  return j * division + Math.floor(u * division);
}

interface Props {
  title: string;
  slug: string;
  engine: Engine;
  stems: StemState[];
  analysis: BassAnalysis | null;
  status: BassState['status'];
  chords: ChordAnalysis | null;
  bpm: number;
  pitch: number;
  strings: BassStringCount;
  onStringsChange: (strings: BassStringCount) => void;
  loop: LoopState;
  duration: number;
  position: number;
  playing: boolean;
  speed: number;
  bassBoost: boolean;
  onSeek: (time: number) => void;
  /** Mini player pinned at the bottom of the page. */
  dock?: ReactNode;
  onClose: () => void;
}

/**
 * Full-page Songsterr-style bass tablature viewer with responsive multi-bar systems (2..5 bars per
 * line), live step cursor, 4/5-string switch, in-page instrument playback selection, bar-snapped
 * A-B looping, inline speed control, automatic bass boost, live bass listening & practice coaching,
 * ASCII view, Markdown export, and PDF score export.
 */
export function BassPage({
  title,
  slug,
  engine,
  stems,
  analysis,
  status,
  chords,
  bpm,
  pitch,
  strings,
  onStringsChange,
  loop,
  duration,
  position,
  playing,
  speed,
  bassBoost,
  onSeek,
  dock,
  onClose,
}: Props) {
  const [view, setView] = useState<View>(readView);
  const barsPerSystem = useBarsPerSystem();
  const meter = analysis?.meter ?? 4;
  const division = analysis?.division ?? 4;
  const swing = analysis?.swing ?? false;
  const stepsPerBar = meter * division;

  useEffect(() => {
    document.title = `${title} · Bass tab · Mosaic`;
    return () => {
      document.title = `${title} · Mosaic`;
    };
  }, [title]);

  const [stemsOpen, setStemsOpen] = useState(false);
  const stemsMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (stemsOpen) setStemsOpen(false);
        else onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, stemsOpen]);

  useEffect(() => {
    if (!stemsOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!stemsMenuRef.current?.contains(e.target as Node)) setStemsOpen(false);
    };
    const onResize = () => {
      if (window.innerWidth >= 768) setStemsOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('resize', onResize);
    };
  }, [stemsOpen]);

  const bars = useMemo(
    () => (!analysis ? [] : pitch || strings !== 5 ? assignBassFingering(analysis.bars, pitch, strings, analysis.division) : analysis.bars),
    [analysis, pitch, strings],
  );
  const chartBars = useMemo(() => (bars.length && chords?.segments.length ? chordChart(chords.segments, bars) : null), [chords, bars]);
  const starts = useStarts(bars);
  const sections = useMemo(() => (bars.length ? bassRoadMap(bars, stepsPerBar) : []), [bars, stepsPerBar]);
  const systems = useMemo(
    () => Array.from({ length: Math.ceil(bars.length / barsPerSystem) }, (_, s) => bars.slice(s * barsPerSystem, (s + 1) * barsPerSystem)),
    [bars, barsPerSystem],
  );
  const systemCharts = useMemo(
    () => systems.map((_, s) => (chartBars ? chartBars.slice(s * barsPerSystem, (s + 1) * barsPerSystem) : null)),
    [systems, chartBars, barsPerSystem],
  );
  const tabMarkdown = useMemo(
    () => (analysis ? formatBassTabMarkdown({ title, analysis, chords, bpm, pitch, strings }) : ''),
    [title, analysis, chords, bpm, pitch, strings],
  );
  const tabAscii = useMemo(
    () => (analysis ? formatBassTabText({ title, analysis, chords, bpm, pitch, strings }) : ''),
    [title, analysis, chords, bpm, pitch, strings],
  );

  const i = bars.length ? segmentAt(bars, starts, position) : -1;
  const currentBarRef = useRef(i);
  currentBarRef.current = i;
  const nowIndex = i >= 0 && bars[i].kind !== 'rest' ? i : bars.findIndex((b, j) => j > i && b.kind !== 'rest');
  const activeSystem = i >= 0 ? Math.floor(i / barsPerSystem) : -1;
  const activeInSystem = i >= 0 ? i % barsPerSystem : -1;
  const activeStep = i >= 0 ? stepAt(bars[i], position, division) : -1;

  const choose = (value: View) => {
    setView(value);
    writeView(value);
  };

  const copyMarkdown = () => {
    void navigator.clipboard?.writeText(tabMarkdown).then(
      () => toast('Bass tab copied'),
      () => toast("Couldn't copy tab"),
    );
  };

  const bassIndex = stems.findIndex((s) => /bass/i.test(s.name));
  const bassOnly = bassIndex >= 0 && Engine.isSolo(stems, bassIndex);
  const bassMuted = bassIndex >= 0 ? stems[bassIndex].muted : false;
  const audibleCount = stems.filter((s) => !s.muted).length;
  const allAudible = audibleCount === stems.length;
  const stemsLabel = allAudible ? 'Stems · All' : `Stems · ${audibleCount}/${stems.length}`;
  const coach = useBassCoach({ bars, division, strings, position, playing, speed });
  const mixRef = useRef<HTMLDivElement>(null);
  const [mixFade, setMixFade] = useState({ left: false, right: false });

  const updateMixFade = useCallback(() => {
    const el = mixRef.current;
    if (!el) return;
    const left = el.scrollLeft > 4;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 4;
    setMixFade((prev) => (prev.left === left && prev.right === right ? prev : { left, right }));
  }, []);

  useEffect(() => {
    const el = mixRef.current;
    if (!el) return;
    updateMixFade();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(updateMixFade) : null;
    ro?.observe(el);
    window.addEventListener('resize', updateMixFade);
    const onWheel = (e: WheelEvent) => {
      if (el.scrollWidth > el.clientWidth + 2 && Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        el.scrollLeft += e.deltaY;
        e.preventDefault();
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', updateMixFade);
      el.removeEventListener('wheel', onWheel);
    };
  }, [stems.length, updateMixFade]);

  useEffect(() => {
    if (bassIndex >= 0) engine.setBassBoost(true);
    return () => engine.setBassBoost(false);
  }, [engine, bassIndex]);

  const handleShiftSelectBar = useCallback(
    (clickedBar: BassBar) => {
      const cur = currentBarRef.current;
      const anchor = cur >= 0 && bars[cur] ? bars[cur] : clickedBar;
      engine.setLoop(Math.min(anchor.start, clickedBar.start), Math.max(anchor.end, clickedBar.end), { enabled: true });
    },
    [engine, bars],
  );

  const emptyMessage =
    status === 'none' ? 'No bass stem' : status === 'error' ? "Couldn't transcribe bass" : 'Analysing bass tab…';

  return (
    <>
      <main className="screen bass-page" aria-label="Bass tab">
        <div className="bass-page__top">
          <div className="bass-page__header">
            <button type="button" className="icon-button" aria-label="Back to mixer" onClick={onClose}>
              <ChevronLeftIcon size={28} />
            </button>
            <div className="bass-page__title-wrap">
              <h1 className="bass-page__title" title={title}>
                {title}
              </h1>
              {analysis && (
                <div className="bass-page__sub">
                  <span className="chord-now__name">{i >= 0 ? `Bar ${i + 1}` : nowIndex >= 0 ? `Bar ${nowIndex + 1}` : 'No bass'}</span>
                  <span className="chord-now__next drum-feel">
                    {strings}-str ({strings === 4 ? 'E–G' : 'B–G'}) · {meter}/4 · {swing ? 'Shuffle' : 'Straight'}
                  </span>
                  {bars.length > 0 && (
                    <span className="chord-meta">
                      Bar {(i >= 0 ? i : Math.max(0, nowIndex)) + 1} of {bars.length} · ♩ = {Math.round(bpm)}
                      {speed !== 1 ? ` · ${Math.round(speed * 100)}%` : ''}
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>

          {analysis && (
            <div className="bass-page__toolbar">
              <div className="segmented" role="group" aria-label="View">
                {(['tab', 'ascii'] as const).map((value) => (
                  <button
                    key={value}
                    type="button"
                    className={`segmented__btn ${view === value ? 'segmented__btn--on' : ''}`}
                    aria-pressed={view === value}
                    onClick={() => choose(value)}
                  >
                    {value === 'tab' ? 'Tab' : 'ASCII'}
                  </button>
                ))}
              </div>

              <div className="segmented" role="group" aria-label="Bass strings">
                {([4, 5] as const).map((count) => (
                  <button
                    key={count}
                    type="button"
                    className={`segmented__btn ${strings === count ? 'segmented__btn--on' : ''}`}
                    aria-pressed={strings === count}
                    onClick={() => onStringsChange(count)}
                  >
                    {count}-string
                  </button>
                ))}
              </div>

              <button
                type="button"
                className={`pill-button pill-button--outline bass-page__listen ${coach.listening ? 'is-on' : ''}`}
                aria-label="Listen to my bass"
                aria-pressed={coach.listening}
                disabled={coach.starting}
                onClick={coach.toggle}
              >
                <MicIcon size={16} />
                <span>{coach.listening ? 'Listening' : 'Listen'}</span>
              </button>

              <div className="bass-page__exports">
                <button type="button" className="pill-button pill-button--outline" onClick={() => window.print()}>
                  Export PDF
                </button>
                <button type="button" className="pill-button pill-button--outline" onClick={() => downloadBassTabMarkdown(slug, tabMarkdown)}>
                  Export .md
                </button>
              </div>
            </div>
          )}
        </div>

        <BassCoachPanel
          coach={coach}
          engine={engine}
          bars={bars}
          strings={strings}
          bassIndex={bassIndex}
          bassMuted={bassMuted}
        />

        <div className="bass-page__body">
          {!analysis ? (
            <p className="bass-page__empty">{emptyMessage}</p>
          ) : view === 'tab' ? (
            <>
              {systems.length > 0 && (
                <SongsterrTabView
                  systems={systems}
                  systemCharts={systemCharts}
                  totalBars={bars.length}
                  barsPerSystem={barsPerSystem}
                  strings={strings}
                  division={division}
                  meter={meter}
                  bpm={bpm}
                  pitch={pitch}
                  songKey={chords?.key ?? null}
                  loop={loop}
                  noteFeedback={coach.listening ? coach.snapshot.grades : undefined}
                  activeSystem={activeSystem}
                  activeInSystem={activeInSystem}
                  activeStep={activeStep}
                  onSeek={onSeek}
                  onShiftSelectBar={handleShiftSelectBar}
                />
              )}

              <h4 className="drum-map__title">Song map</h4>
              <div className="drum-map">
                {sections.map((s) => {
                  const current = i >= s.first && i < s.first + s.count;
                  const sectionLooped =
                    loop.enabled &&
                    loop.start !== null &&
                    loop.end !== null &&
                    Math.abs(loop.start - s.start) < 0.05 &&
                    Math.abs(loop.end - s.end) < 0.05;
                  const sectionLoopLabel = s.count > 1 ? `Loop bars ${s.first + 1} to ${s.first + s.count}` : `Loop bar ${s.first + 1}`;
                  return (
                    <div key={s.first} className="drum-map__row">
                      <button
                        type="button"
                        className={`drum-map__item drum-map__item--${s.kind === 'riff' ? 'groove' : s.kind} ${current ? 'is-now' : ''}`}
                        onClick={() => onSeek(s.start)}
                      >
                        <span className="drum-map__bars">{s.count > 1 ? `${s.first + 1}–${s.first + s.count}` : s.first + 1}</span>
                        {s.kind === 'rest' ? (
                          <span className="drum-map__rest">No bass</span>
                        ) : (
                          <MiniTab notes={s.notes} steps={s.steps} beats={s.steps / division} strings={strings} />
                        )}
                        <span className="drum-map__count">{s.kind === 'fill' ? 'Fill' : `×${s.count}`}</span>
                      </button>
                      <button
                        type="button"
                        className={`drum-map__loop ${sectionLooped ? 'is-on' : ''}`}
                        aria-label={sectionLoopLabel}
                        aria-pressed={sectionLooped}
                        onClick={() => {
                          if (sectionLooped) engine.toggleLoop();
                          else engine.setLoop(s.start, s.end, { enabled: true, seekToStart: true });
                        }}
                      >
                        <LoopIcon size={18} />
                      </button>
                    </div>
                  );
                })}
              </div>
            </>
          ) : (
            <div className="bass-ascii-wrap">
              <button type="button" className="pill-button pill-button--outline bass-copy" onClick={copyMarkdown}>
                Copy Markdown tab
              </button>
              <pre className="bass-ascii">{tabAscii}</pre>
            </div>
          )}
        </div>

        <div className="bass-page__dock">
          <div className={`bass-mix-wrap ${mixFade.left ? 'has-fade-left' : ''} ${mixFade.right ? 'has-fade-right' : ''}`}>
            <div ref={mixRef} className="bass-mix" role="group" aria-label="Instruments to play" onScroll={updateMixFade}>
              {bassIndex >= 0 && (
                <>
                  <button
                    type="button"
                    className={`bass-mix__btn ${bassOnly ? 'is-on' : ''}`}
                    aria-pressed={bassOnly}
                    onClick={() => engine.toggleSolo(bassIndex)}
                  >
                    Bass only
                  </button>
                  <button
                    type="button"
                    className={`bass-mix__btn bass-mix__boost ${bassBoost ? 'is-on' : ''}`}
                    aria-pressed={bassBoost}
                    onClick={() => engine.setBassBoost(!bassBoost)}
                  >
                    Bass boost
                  </button>
                </>
              )}
              {stems.length > 0 && (
                <div ref={stemsMenuRef} className={`bass-mix__dropdown ${stemsOpen ? 'is-open' : ''}`}>
                  <button
                    type="button"
                    className={`bass-mix__btn bass-mix__trigger ${stemsOpen ? 'is-open' : ''}`}
                    aria-haspopup="true"
                    aria-expanded={stemsOpen}
                    aria-controls="bass-mix-stems-menu"
                    onClick={() => setStemsOpen((o) => !o)}
                  >
                    <span>{stemsLabel}</span>
                    <ChevronDownIcon size={15} className="bass-mix__chev" />
                  </button>
                  <div id="bass-mix-stems-menu" className="bass-mix__menu">
                    <button
                      type="button"
                      className={`bass-mix__btn ${allAudible ? 'is-on' : ''}`}
                      aria-pressed={allAudible}
                      onClick={() => engine.unmuteAll()}
                    >
                      All
                    </button>
                    <span className="bass-mix__sep" aria-hidden="true" />
                    {stems.map((stem, idx) => {
                      const { label, Icon } = stemMeta(stem.name);
                      const on = !stem.muted;
                      return (
                        <button
                          key={`${stem.name}-${idx}`}
                          type="button"
                          className={`bass-mix__btn ${on ? 'is-on' : ''}`}
                          aria-pressed={on}
                          onClick={() => engine.toggleMute(idx)}
                        >
                          <Icon size={15} />
                          <span>{label}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          </div>
          <div className="bass-page__transport">
            <LoopBar engine={engine} loop={loop} position={position} duration={duration} bars={bars} snapToBars speed={speed} showSpeed />
            {dock}
          </div>
        </div>
      </main>
      {analysis && createPortal(<BassScore title={title} analysis={analysis} chords={chords} bpm={bpm} pitch={pitch} strings={strings} />, document.body)}
    </>
  );
}

interface SongsterrProps {
  systems: BassBar[][];
  systemCharts: (ChartBar[] | null)[];
  totalBars: number;
  barsPerSystem: number;
  strings: BassStringCount;
  division: 3 | 4;
  meter: 3 | 4;
  bpm: number;
  pitch: number;
  songKey: ChordAnalysis['key'];
  loop: LoopState;
  noteFeedback?: ReadonlyMap<string, NoteGrade>;
  activeSystem: number;
  activeInSystem: number;
  activeStep: number;
  onSeek: (time: number) => void;
  onShiftSelectBar: (bar: BassBar) => void;
}

function SongsterrTabView({
  systems,
  systemCharts,
  totalBars,
  barsPerSystem,
  strings,
  division,
  meter,
  bpm,
  pitch,
  songKey,
  loop,
  noteFeedback,
  activeSystem,
  activeInSystem,
  activeStep,
  onSeek,
  onShiftSelectBar,
}: SongsterrProps) {
  const ref = useRef<HTMLDivElement>(null);
  const lastSys = useRef(-1);

  // Page-at-a-time auto-scroll matching ChordSheet: turns the page when the playing system leaves view,
  // and leaves a reader who scrolled down to the song map alone.
  useEffect(() => {
    const prev = lastSys.current;
    lastSys.current = activeSystem;
    const container = ref.current;
    const body = container?.closest('.bass-page__body');
    const sysEl = activeSystem >= 0 ? container?.children[activeSystem] : undefined;
    if (activeSystem < 0 || !body || !sysEl) return;

    const view = body.getBoundingClientRect();
    const top = view.top;
    const padTop = parseFloat(getComputedStyle(body).paddingTop) || 0;
    const inView = (el: Element, whole: boolean) => {
      const r = el.getBoundingClientRect();
      return whole ? r.top >= top - 1 && r.bottom <= view.bottom + 1 : r.bottom > top && r.top < view.bottom;
    };
    if (inView(sysEl, true)) return;
    const before = prev >= 0 ? container?.children[prev] : null;
    if (before && !inView(before, false)) return;
    body.scrollTo({ top: body.scrollTop + sysEl.getBoundingClientRect().top - view.top - padTop, behavior: 'smooth' });
  }, [activeSystem]);

  return (
    <div className="songsterr-sheet" ref={ref}>
      {systems.map((sysBars, s) => {
        const isHere = s === activeSystem;
        return (
          <BassTabSystem
            key={s}
            bars={sysBars}
            firstBar={s * barsPerSystem}
            totalBars={totalBars}
            barsPerSystem={barsPerSystem}
            strings={strings}
            division={division}
            meter={meter}
            bpm={bpm}
            activeBar={isHere ? activeInSystem : -1}
            activeStep={isHere ? activeStep : -1}
            chartBars={systemCharts[s]}
            pitch={pitch}
            songKey={songKey}
            loop={loop}
            noteFeedback={noteFeedback}
            onSeek={onSeek}
            onShiftSelectBar={onShiftSelectBar}
          />
        );
      })}
    </div>
  );
}
