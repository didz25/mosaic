import type { BassBar, BassStringCount } from '../../audio/bass';
import { fretLabel, midiToNoteName } from '../../audio/bassCoach';
import type { Engine } from '../../audio/Engine';
import { CloseIcon } from '../icons';
import type { BassCoachControls } from './useBassCoach';

interface Props {
  coach: BassCoachControls;
  engine: Engine;
  bars: BassBar[];
  strings: BassStringCount;
  bassIndex: number;
  bassMuted: boolean;
}

/**
 * Real-time bass practice coach panel: displays detected note & tuning cents, target note,
 * accuracy/timing stats, pass comparison across loops, audio input settings, and one-click
 * correction actions (loop problem bar, slow down, mute song bass).
 */
export function BassCoachPanel({ coach, engine, bars, strings, bassIndex, bassMuted }: Props) {
  const { listening, error, devices, deviceId, latencyMs, frame, snapshot } = coach;

  if (!listening && !error) return null;

  if (error && !listening) {
    return (
      <section className="bass-coach bass-coach--error" aria-label="Bass coach">
        <p className="bass-coach__err-text">{error}</p>
        <div className="bass-coach__err-actions">
          <button type="button" className="bass-coach__action" onClick={() => void coach.start()}>
            Retry
          </button>
          <button type="button" className="icon-button" aria-label="Dismiss error" onClick={coach.dismissError}>
            <CloseIcon size={16} />
          </button>
        </div>
      </section>
    );
  }

  const levelPct = Math.min(100, Math.round(frame.rms * 600));
  const target = snapshot.currentTarget;
  const centsSign = frame.cents > 0 ? `+${frame.cents}` : String(frame.cents);
  const centsOffset = Math.max(-50, Math.min(50, frame.cents));
  const timingText =
    snapshot.avgTimingMs === null
      ? '—'
      : Math.abs(snapshot.avgTimingMs) <= 20
        ? 'In pocket'
        : `${snapshot.avgTimingMs > 0 ? '+' : ''}${snapshot.avgTimingMs} ms`;
  const lastPass = snapshot.passes.at(-1);

  return (
    <section className="bass-coach" aria-label="Bass coach">
      <div className="bass-coach__live">
        <div className="bass-coach__meter" aria-hidden="true">
          <span className="bass-coach__meter-fill" style={{ width: `${levelPct}%` }} />
        </div>

        <div className="bass-coach__readout">
          <span className="bass-coach__you">
            <small>You</small>
            <strong>{frame.noteName ?? '—'}</strong>
            {frame.noteName && (
              <span className={`bass-coach__cents ${Math.abs(frame.cents) <= 15 ? 'is-in' : ''}`}>{centsSign}¢</span>
            )}
          </span>

          <div className="bass-coach__gauge" aria-hidden="true">
            <span className="bass-coach__gauge-mid" />
            {frame.noteName && <span className="bass-coach__gauge-dot" style={{ left: `${50 + centsOffset}%` }} />}
          </div>

          {target && (
            <span className="bass-coach__target">
              <small>Target</small>
              <strong>
                {midiToNoteName(target.midi)} ({fretLabel(target.string, target.fret, strings)})
              </strong>
            </span>
          )}
        </div>

        <p className={`bass-coach__cue bass-coach__cue--${snapshot.liveCueKind}`} aria-live="polite">
          {snapshot.liveCue}
        </p>

        <div className="bass-coach__stats">
          <span className="bass-coach__stat">
            <small>Match</small>
            <strong>{snapshot.accuracy !== null ? `${snapshot.accuracy}%` : '—'}</strong>
          </span>
          <span className="bass-coach__stat">
            <small>Pitch</small>
            <strong>{snapshot.pitchAccuracy !== null ? `${snapshot.pitchAccuracy}%` : '—'}</strong>
          </span>
          <span className="bass-coach__stat">
            <small>Timing</small>
            <strong>{timingText}</strong>
          </span>
          {lastPass && snapshot.bestPassAccuracy !== null && (
            <span className="bass-coach__stat">
              <small>Loops</small>
              <strong>
                Last {lastPass.accuracy}% · Best {snapshot.bestPassAccuracy}%
              </strong>
            </span>
          )}
        </div>
      </div>

      <div className="bass-coach__controls">
        {bassIndex >= 0 && (
          <button
            type="button"
            className={`bass-coach__pill ${bassMuted ? 'is-on' : ''}`}
            aria-pressed={bassMuted}
            onClick={() => engine.toggleMute(bassIndex)}
          >
            {bassMuted ? 'Song bass muted' : 'Mute song bass'}
          </button>
        )}

        <div className="bass-coach__offset" role="group" aria-label="Input offset">
          <button
            type="button"
            className="bass-coach__step"
            aria-label="Decrease input offset"
            disabled={latencyMs <= -150}
            onClick={() => coach.setLatencyMs(latencyMs - 10)}
          >
            −
          </button>
          <span className="bass-coach__offset-val">
            Offset {latencyMs > 0 ? `+${latencyMs}` : latencyMs} ms
          </span>
          <button
            type="button"
            className="bass-coach__step"
            aria-label="Increase input offset"
            disabled={latencyMs >= 150}
            onClick={() => coach.setLatencyMs(latencyMs + 10)}
          >
            +
          </button>
        </div>

        {devices.length > 1 && (
          <select
            className="bass-coach__select"
            aria-label="Audio input device"
            value={deviceId}
            onChange={(e) => coach.setDeviceId(e.target.value)}
          >
            <option value="">Default input</option>
            {devices.map((d, idx) => (
              <option key={d.deviceId || idx} value={d.deviceId}>
                {d.label || `Input ${idx + 1}`}
              </option>
            ))}
          </select>
        )}

        <button type="button" className="bass-coach__pill" aria-label="Reset practice stats" onClick={coach.resetStats}>
          Reset
        </button>
      </div>

      {snapshot.tips.length > 0 && (
        <ul className="bass-coach__tips">
          {snapshot.tips.map((tip) => (
            <li key={tip.id} className={`bass-coach__tip bass-coach__tip--${tip.kind}`}>
              <span>{tip.text}</span>
              {tip.barIndex !== undefined && bars[tip.barIndex] && (
                <button
                  type="button"
                  className="bass-coach__action"
                  onClick={() =>
                    engine.setLoop(bars[tip.barIndex!].start, bars[tip.barIndex!].end, {
                      enabled: true,
                      seekToStart: true,
                    })
                  }
                >
                  Loop bar {tip.barIndex + 1}
                </button>
              )}
              {tip.suggestedSpeed !== undefined && (
                <button type="button" className="bass-coach__action" onClick={() => engine.setSpeed(tip.suggestedSpeed!)}>
                  Slow to {Math.round(tip.suggestedSpeed * 100)}%
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
