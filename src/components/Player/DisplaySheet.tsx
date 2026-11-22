import type { ReactNode } from 'react';
import type { BassStringCount } from '../../audio/bass';
import { Sheet } from './Sheet';

interface Props {
  showChords: boolean;
  onToggleChords: () => void;
  showDrums: boolean;
  onToggleDrums: () => void;
  showBass: boolean;
  onToggleBass: () => void;
  showWaves: boolean;
  onToggleWaves: () => void;
  bassStrings: BassStringCount;
  onBassStringsChange: (strings: BassStringCount) => void;
  /** Mini player pinned under the sheet. */
  dock?: ReactNode;
  onClose: () => void;
}

/**
 * Strip display and bass tuning options sheet: choose which strips to display (Chords, Drums,
 * Bass tab, Waveforms) and toggle 4-string vs 5-string bass tablature.
 */
export function DisplaySheet({
  showChords,
  onToggleChords,
  showDrums,
  onToggleDrums,
  showBass,
  onToggleBass,
  showWaves,
  onToggleWaves,
  bassStrings,
  onBassStringsChange,
  dock,
  onClose,
}: Props) {
  return (
    <Sheet title="Strips & bass" onClose={onClose} dock={dock}>
      <div className="sheet-row">
        <span>
          Chords
          <small>Key &amp; chord progression</small>
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={showChords}
          aria-label="Chords strip"
          className={`switch ${showChords ? 'switch--on' : ''}`}
          onClick={onToggleChords}
        >
          <span className="switch__knob" />
        </button>
      </div>
      <div className="sheet-row">
        <span>
          Drums
          <small>Beat &amp; groove chart</small>
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={showDrums}
          aria-label="Drums strip"
          className={`switch ${showDrums ? 'switch--on' : ''}`}
          onClick={onToggleDrums}
        >
          <span className="switch__knob" />
        </button>
      </div>
      <div className="sheet-row">
        <span>
          Bass tab
          <small>Scrolling bass tablature</small>
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={showBass}
          aria-label="Bass tab strip"
          className={`switch ${showBass ? 'switch--on' : ''}`}
          onClick={onToggleBass}
        >
          <span className="switch__knob" />
        </button>
      </div>
      <div className="sheet-row">
        <span>
          Waveforms
          <small>Behind stem sliders</small>
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={showWaves}
          aria-label="Stem waveforms"
          className={`switch ${showWaves ? 'switch--on' : ''}`}
          onClick={onToggleWaves}
        >
          <span className="switch__knob" />
        </button>
      </div>

      <div className="display-bass">
        <div className="display-bass__head">
          <span>Bass strings</span>
          <small>{bassStrings === 4 ? 'E–A–D–G' : 'B–E–A–D–G'}</small>
        </div>
        <div className="segmented" role="group" aria-label="Bass strings">
          {([4, 5] as const).map((count) => (
            <button
              key={count}
              type="button"
              className={`segmented__btn ${bassStrings === count ? 'segmented__btn--on' : ''}`}
              aria-pressed={bassStrings === count}
              onClick={() => onBassStringsChange(count)}
            >
              {count === 4 ? '4-string (E–G)' : '5-string (B–G)'}
            </button>
          ))}
        </div>
      </div>
    </Sheet>
  );
}
