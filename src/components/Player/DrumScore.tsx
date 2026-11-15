import type { ReactElement } from 'react';
import { LANES, isGhost, type DrumAnalysis, type DrumBar, type DrumLane } from '../../audio/drums';

const POSITION: Record<DrumLane, number> = { crash: 10, openHat: 9, hat: 9, highTom: 7, snare: 5, lowTom: 3, kick: 1 };
const KICK = LANES.indexOf('kick');
const SYSTEM_WIDTH = 760;
const SYSTEM_HEIGHT = 168;
const STAFF_TOP = 58;
const STAFF_GAP = 16;
const STAFF_BOTTOM = STAFF_TOP + 4 * STAFF_GAP;
const STAFF_LEFT = 84;
const STAFF_RIGHT = 752;
const BARS_PER_SYSTEM = 3;
const y = (position: number) => STAFF_BOTTOM - (position * STAFF_GAP) / 2;

interface Props {
  title: string;
  analysis: DrumAnalysis;
}

/** Full-song percussion score used by the browser's print-to-PDF view. */
export function DrumScore({ title, analysis }: Props) {
  const systems = Array.from({ length: Math.ceil(analysis.bars.length / BARS_PER_SYSTEM) }, (_, i) =>
    analysis.bars.slice(i * BARS_PER_SYSTEM, (i + 1) * BARS_PER_SYSTEM),
  );

  return (
    <article className="drum-score-print">
      <header className="drum-score-print__header">
        <h1>{title}</h1>
        <p>
          Drum set · {analysis.meter}/4 · {analysis.swing ? 'Shuffle' : 'Straight'}
        </p>
      </header>
      {systems.map((bars, i) => (
        <ScoreSystem key={i} bars={bars} firstBar={i * BARS_PER_SYSTEM + 1} analysis={analysis} />
      ))}
    </article>
  );
}

function ScoreSystem({ bars, firstBar, analysis }: { bars: DrumBar[]; firstBar: number; analysis: DrumAnalysis }) {
  const measureWidth = (STAFF_RIGHT - STAFF_LEFT) / BARS_PER_SYSTEM;
  return (
    <svg
      className="drum-score-print__system"
      viewBox={`0 0 ${SYSTEM_WIDTH} ${SYSTEM_HEIGHT}`}
      role="img"
      aria-label={`Drum score bars ${firstBar} to ${firstBar + bars.length - 1}`}
    >
      {[0, 1, 2, 3, 4].map((line) => (
        <line
          key={line}
          className="drum-score-print__staff"
          x1={STAFF_LEFT}
          x2={STAFF_RIGHT}
          y1={STAFF_TOP + line * STAFF_GAP}
          y2={STAFF_TOP + line * STAFF_GAP}
        />
      ))}
      <text className="drum-score-print__instrument" x="6" y={STAFF_TOP + 5}>
        Drum Set
      </text>
      <rect className="drum-score-print__clef" x="54" y={STAFF_TOP + 17} width="3" height="22" />
      <rect className="drum-score-print__clef" x="61" y={STAFF_TOP + 17} width="3" height="22" />
      <text className="drum-score-print__meter" x="73" y={STAFF_TOP + 26}>
        {analysis.meter}
      </text>
      <text className="drum-score-print__meter" x="73" y={STAFF_TOP + 42}>
        4
      </text>
      <line className="drum-score-print__barline" x1={STAFF_LEFT} x2={STAFF_LEFT} y1={STAFF_TOP} y2={STAFF_BOTTOM} />
      {bars.map((bar, i) => {
        const x0 = STAFF_LEFT + (i + 1) * measureWidth;
        const finalBar = i === bars.length - 1;
        return (
          <g key={firstBar + i}>
            <text className="drum-score-print__number" x={STAFF_LEFT + i * measureWidth + 4} y="47">
              {firstBar + i}
            </text>
            <line className="drum-score-print__barline" x1={x0} x2={x0} y1={STAFF_TOP} y2={STAFF_BOTTOM} />
            {finalBar && (
              <line className="drum-score-print__barline" x1={x0 - 4} x2={x0 - 4} y1={STAFF_TOP} y2={STAFF_BOTTOM} />
            )}
            {bar.kind === 'rest' ? (
              <rect className="drum-score-print__note" x={x0 - measureWidth / 2 - 7} y={STAFF_TOP + 8} width="14" height="6" />
            ) : (
              <MeasureNotes bar={bar} division={analysis.division} x0={STAFF_LEFT + i * measureWidth} width={measureWidth} />
            )}
          </g>
        );
      })}
    </svg>
  );
}

function MeasureNotes({ bar, division, x0, width }: { bar: DrumBar; division: number; x0: number; width: number }) {
  const steps = bar.steps[0].length;
  const noteX = (step: number) => x0 + 8 + ((step + 0.5) * (width - 16)) / steps;
  const notes = bar.steps.flatMap((lane, l) => lane.map((value, step) => ({ lane: l, step, value })).filter((note) => note.value > 0));
  const voices = [notes.filter((note) => note.lane !== KICK), notes.filter((note) => note.lane === KICK)];

  return (
    <g>
      {voices.map((voice, i) => (
        <Voice key={i} notes={voice} up={i === 0} steps={steps} division={division} noteX={noteX} />
      ))}
      {notes.map((note) => (
        <NoteHead key={`${note.lane}-${note.step}`} lane={LANES[note.lane]} cx={noteX(note.step)} value={note.value} />
      ))}
    </g>
  );
}

function NoteHead({ lane, cx, value }: { lane: DrumLane; cx: number; value: number }) {
  const cy = y(POSITION[lane]);
  return (
    <g className="drum-score-print__head" opacity={0.45 + 0.55 * value}>
      {lane === 'crash' && <line x1={cx - 8} x2={cx + 8} y1={cy} y2={cy} />}
      {lane === 'crash' || lane === 'openHat' || lane === 'hat' ? (
        <path d={`M${cx - 3.8} ${cy - 3.8}l7.6 7.6M${cx + 3.8} ${cy - 3.8}l-7.6 7.6`} />
      ) : (
        <ellipse cx={cx} cy={cy} rx="4.6" ry="3.3" transform={`rotate(-20 ${cx} ${cy})`} className="drum-score-print__note" />
      )}
      {lane === 'openHat' && <circle cx={cx} cy={cy - 11} r="2.6" className="drum-score-print__open" />}
      {isGhost(value) && (
        <path d={`M${cx - 7} ${cy - 5}q-3 5 0 10M${cx + 7} ${cy - 5}q3 5 0 10`} className="drum-score-print__ghost" />
      )}
    </g>
  );
}

function Voice({
  notes,
  up,
  steps,
  division,
  noteX,
}: {
  notes: { lane: number; step: number }[];
  up: boolean;
  steps: number;
  division: number;
  noteX: (step: number) => number;
}) {
  const elements: ReactElement[] = [];
  const stemEnd = up ? 24 : 146;
  const stemX = (step: number) => noteX(step) + (up ? 4.2 : -4.2);
  const beamDirection = up ? 1 : -1;

  for (let beat = 0; beat * division < steps; beat++) {
    const columns = [...new Set(notes.filter((note) => Math.floor(note.step / division) === beat).map((note) => note.step))].sort(
      (a, b) => a - b,
    );
    if (!columns.length) continue;

    for (const step of columns) {
      const positions = notes.filter((note) => note.step === step).map((note) => y(POSITION[LANES[note.lane]]));
      const from = up ? Math.max(...positions) : Math.min(...positions);
      elements.push(
        <line key={`stem-${step}`} className="drum-score-print__stem" x1={stemX(step)} x2={stemX(step)} y1={from} y2={stemEnd} />,
      );
    }

    const sixteenth = division === 4 && columns.some((step) => step % 2 === 1);
    if (columns.length > 1) {
      const beamCount = sixteenth ? 2 : 1;
      for (let beam = 0; beam < beamCount; beam++) {
        const beamY = stemEnd + beamDirection * beam * 5 - (up ? 0 : 3);
        elements.push(
          <rect
            key={`beam-${beat}-${beam}`}
            className="drum-score-print__note"
            x={stemX(columns[0]) - 0.8}
            y={beamY}
            width={stemX(columns[columns.length - 1]) - stemX(columns[0]) + 1.6}
            height="3"
          />,
        );
      }
      if (division === 3 && up) {
        elements.push(
          <text key={`triplet-${beat}`} className="drum-score-print__tuplet" x={(stemX(columns[0]) + stemX(columns[columns.length - 1])) / 2} y="22">
            3
          </text>,
        );
      }
    } else {
      const step = columns[0];
      const flags = step % division === 0 ? 0 : sixteenth ? 2 : 1;
      for (let flag = 0; flag < flags; flag++) {
        const flagY = stemEnd + beamDirection * flag * 5;
        elements.push(
          <path
            key={`flag-${step}-${flag}`}
            className="drum-score-print__flag"
            d={`M${stemX(step)} ${flagY}q7 ${beamDirection * 5} 5 ${beamDirection * 12}`}
          />,
        );
      }
    }
  }
  return <g>{elements}</g>;
}
