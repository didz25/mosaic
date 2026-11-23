import { MIN_LOOP_DURATION, type Engine, type LoopState } from '../../audio/Engine';
import { firstBeatAtOrAfter } from '../../audio/metronome';
import { formatTime } from '../../lib/format';
import { CloseIcon, LoopIcon } from '../icons';

export interface LoopBarSpan {
  start: number;
  end: number;
}

/** Find the index of the bar containing `t` (or the nearest bar before `t` if past the end). */
export function barIndexAt(bars: LoopBarSpan[], t: number): number {
  if (!bars.length) return -1;
  const starts = bars.map((b) => b.start);
  const idx = firstBeatAtOrAfter(starts, t + 1e-6) - 1;
  if (idx < 0) return 0;
  return Math.min(bars.length - 1, idx);
}

/** Visual A-B loop range & markers overlaid on a seek slider track. */
export function LoopOverlay({ loop, duration }: { loop: LoopState; duration: number }) {
  if (duration <= 0 || (loop.start === null && loop.end === null)) return null;
  const pct = (t: number) => `${Math.max(0, Math.min(100, (t / duration) * 100))}%`;
  const hasRange = loop.start !== null && loop.end !== null && loop.end > loop.start;
  const cls = loop.enabled ? 'is-on' : '';

  return (
    <div className={`loop-overlay ${cls}`} aria-hidden="true">
      {hasRange && (
        <span
          className="loop-overlay__range"
          style={{ left: pct(loop.start!), width: `${Math.max(0, ((loop.end! - loop.start!) / duration) * 100)}%` }}
        />
      )}
      {loop.start !== null && <span className="loop-overlay__marker loop-overlay__marker--a" style={{ left: pct(loop.start) }} />}
      {loop.end !== null && <span className="loop-overlay__marker loop-overlay__marker--b" style={{ left: pct(loop.end) }} />}
    </div>
  );
}

interface Props {
  engine: Engine;
  loop: LoopState;
  position: number;
  duration: number;
  disabled?: boolean;
  bars?: LoopBarSpan[];
  /** When true (BassPage), A and B snap to whole bar boundaries and include +-1 bar steppers. */
  snapToBars?: boolean;
  /** Current playback speed (0.5 .. 1.5). */
  speed?: number;
  /** Show inline speed stepper (enabled in A-B loop mode and on BassPage). */
  showSpeed?: boolean;
}

/**
 * Compact A-B loop bar shared by the main mixer and the Bass Tab dock.
 * Supports free timestamp capture (main mixer) and bar-snapped looping with +-1 bar steppers (Bass tab),
 * plus inline playback speed control when looping or practicing bass.
 */
export function LoopBar({ engine, loop, position, duration, disabled, bars, snapToBars = false, speed = 1, showSpeed = false }: Props) {
  const hasBars = !!bars?.length;
  const snap = snapToBars && hasBars;
  const hasLoop = loop.start !== null || loop.end !== null;
  const canToggle = loop.start !== null && loop.end !== null;

  const aBar = snap && loop.start !== null ? barIndexAt(bars!, loop.start + 1e-3) : -1;
  const bBar = snap && loop.end !== null ? barIndexAt(bars!, Math.max(0, loop.end - 1e-3)) : -1;
  const aSnapped = snap && loop.start !== null && Math.abs(loop.start - bars![aBar].start) < 0.05;
  const bSnapped = snap && loop.end !== null && Math.abs(loop.end - bars![bBar].end) < 0.05;

  const aText = loop.start === null ? 'A' : aSnapped ? `A · ${aBar + 1}` : `A ${formatTime(loop.start)}`;
  const bText = loop.end === null ? 'B' : bSnapped ? `B · ${bBar + 1}` : `B ${formatTime(loop.end)}`;

  const handleSetA = () => {
    if (snap) {
      const idx = barIndexAt(bars!, position);
      engine.setLoopA(bars![idx].start);
    } else {
      engine.setLoopA(position);
    }
  };

  const handleSetB = () => {
    if (snap) {
      const idx = barIndexAt(bars!, position);
      if (loop.start !== null && bars![idx].end <= loop.start + 0.05) {
        const aIdx = barIndexAt(bars!, loop.start + 1e-3);
        engine.setLoop(bars![idx].start, bars![Math.max(idx, aIdx)].end, { enabled: true });
      } else {
        engine.setLoopB(bars![idx].end);
      }
    } else {
      engine.setLoopB(position);
    }
  };

  const handleToggle = () => {
    if (canToggle) {
      engine.toggleLoop();
      return;
    }
    if (loop.start !== null) {
      if (snap) {
        const aIdx = barIndexAt(bars!, loop.start + 1e-3);
        const curIdx = barIndexAt(bars!, position);
        engine.setLoop(bars![aIdx].start, bars![Math.max(aIdx, curIdx)].end, { enabled: true });
      } else if (position > loop.start + MIN_LOOP_DURATION) {
        engine.setLoopB(position);
      } else {
        engine.setLoop(loop.start, Math.min(duration, loop.start + 8), { enabled: true });
      }
      return;
    }
    if (hasBars) {
      const idx = barIndexAt(bars!, position);
      engine.setLoop(bars![idx].start, bars![idx].end, { enabled: true });
      return;
    }
    const start = Math.max(0, Math.min(position, Math.max(0, duration - 8)));
    const end = Math.min(duration, start + 8);
    if (end - start >= MIN_LOOP_DURATION) engine.setLoop(start, end, { enabled: true });
  };

  const nudgeA = (delta: number) => {
    if (!snap || loop.end === null) return;
    const maxIdx = Math.max(0, bBar);
    const cur = aBar >= 0 ? aBar : 0;
    const nextIdx = Math.max(0, Math.min(maxIdx, cur + delta));
    engine.setLoop(bars![nextIdx].start, loop.end, { enabled: loop.enabled });
  };

  const nudgeB = (delta: number) => {
    if (!snap || loop.start === null) return;
    const minIdx = Math.max(0, aBar);
    const cur = bBar >= 0 ? bBar : minIdx;
    const nextIdx = Math.max(minIdx, Math.min(bars!.length - 1, cur + delta));
    engine.setLoop(loop.start, bars![nextIdx].end, { enabled: loop.enabled });
  };

  const showSteppers = snap && canToggle;
  const barClasses = [
    'loop-bar',
    hasLoop && 'loop-bar--loop',
    showSpeed && 'loop-bar--speed',
    showSteppers && 'loop-bar--steppers',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className="loop-bar-wrap">
      <div className={barClasses} role="group" aria-label="A–B loop">
        <div className="loop-bar__group loop-bar__a">
          {showSteppers && (
            <button
              type="button"
              className="loop-bar__step"
              aria-label="Earlier start bar"
              disabled={disabled || aBar <= 0}
              onClick={() => nudgeA(-1)}
            >
              −
            </button>
          )}
          <button
            type="button"
            className={`loop-bar__btn ${loop.start !== null ? 'is-set' : ''}`}
            aria-label="Set loop start A"
            aria-pressed={loop.start !== null}
            disabled={disabled}
            onClick={handleSetA}
          >
            {aText}
          </button>
          {showSteppers && (
            <button
              type="button"
              className="loop-bar__step"
              aria-label="Later start bar"
              disabled={disabled || aBar >= bBar}
              onClick={() => nudgeA(1)}
            >
              +
            </button>
          )}
        </div>

        <div className="loop-bar__group loop-bar__b">
          {showSteppers && (
            <button
              type="button"
              className="loop-bar__step"
              aria-label="Earlier end bar"
              disabled={disabled || bBar <= aBar}
              onClick={() => nudgeB(-1)}
            >
              −
            </button>
          )}
          <button
            type="button"
            className={`loop-bar__btn ${loop.end !== null ? 'is-set' : ''}`}
            aria-label="Set loop end B"
            aria-pressed={loop.end !== null}
            disabled={disabled}
            onClick={handleSetB}
          >
            {bText}
          </button>
          {showSteppers && (
            <button
              type="button"
              className="loop-bar__step"
              aria-label="Later end bar"
              disabled={disabled || bBar >= bars!.length - 1}
              onClick={() => nudgeB(1)}
            >
              +
            </button>
          )}
        </div>

        <button
          type="button"
          className={`loop-bar__toggle ${loop.enabled ? 'is-on' : ''}`}
          aria-label="A-B loop"
          aria-pressed={loop.enabled}
          disabled={disabled || duration < MIN_LOOP_DURATION}
          onClick={handleToggle}
        >
          <LoopIcon size={15} />
          <span>{snap && !hasLoop ? 'Loop bar' : 'Loop'}</span>
        </button>

        {hasLoop && (
          <button type="button" className="loop-bar__clear" aria-label="Clear loop" disabled={disabled} onClick={() => engine.clearLoop()}>
            <CloseIcon size={15} />
          </button>
        )}

        {showSpeed && (
          <div className="loop-bar__group loop-bar__speed" role="group" aria-label="Playback speed">
            <button
              type="button"
              className="loop-bar__step"
              aria-label="Slower"
              disabled={disabled || speed <= 0.5}
              onClick={() => engine.setSpeed(speed - 0.05)}
            >
              −
            </button>
            <button
              type="button"
              className={`loop-bar__btn ${speed !== 1 ? 'is-set' : ''}`}
              aria-label={speed === 1 ? 'Playback speed 100%' : `Reset speed from ${Math.round(speed * 100)}% to 100%`}
              disabled={disabled || speed === 1}
              title={speed === 1 ? 'Playback speed' : 'Reset speed to 100%'}
              onClick={() => engine.setSpeed(1)}
            >
              {Math.round(speed * 100)}%
            </button>
            <button
              type="button"
              className="loop-bar__step"
              aria-label="Faster"
              disabled={disabled || speed >= 1.5}
              onClick={() => engine.setSpeed(speed + 0.05)}
            >
              +
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
