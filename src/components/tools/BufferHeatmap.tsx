"use client";

import { useMemo, useState } from "react";
import { formatPercent } from "@/lib/format";
import type { AsymmetricSweepRow, ObjectiveKey } from "@/lib/simulation/buffer-grid-search";
import { scoreRow } from "@/lib/simulation/buffer-grid-search";

interface Props {
  rows: AsymmetricSweepRow[];
  objective: ObjectiveKey;
  inflationPct: number;
  /** Where to mark the picked top cell. */
  highlight?: { upper: number; lower: number } | null;
  /** Optional rectangular hint for the fine-search window (in buffer %). */
  fineWindow?: { minU: number; maxU: number; minL: number; maxL: number } | null;
}

interface Cell {
  upper: number;
  lower: number;
  score: number;
  row: AsymmetricSweepRow;
}

const CHART_WIDTH = 560;
const CHART_HEIGHT = 420;
const MARGIN = { top: 24, right: 80, bottom: 56, left: 60 };

function valueToColor(t: number): string {
  const clamped = Math.max(0, Math.min(1, t));
  // Cool→warm: blue (low) → orange (high)
  const r = Math.round(35 + clamped * 215);
  const g = Math.round(80 + clamped * 70);
  const b = Math.round(220 - clamped * 180);
  return `rgb(${r}, ${g}, ${b})`;
}

export function BufferHeatmap({ rows, objective, inflationPct, highlight, fineWindow }: Props) {
  const [hovered, setHovered] = useState<Cell | null>(null);

  const { cells, uppers, lowers, minScore, maxScore } = useMemo(() => {
    const cells: Cell[] = rows.map((row) => ({
      upper: row.upperBuffer,
      lower: row.lowerBuffer,
      score: scoreRow(row, objective, inflationPct),
      row,
    }));
    const finiteScores = cells.map((c) => c.score).filter((s) => isFinite(s));
    const minScore = finiteScores.length > 0 ? Math.min(...finiteScores) : 0;
    const maxScore = finiteScores.length > 0 ? Math.max(...finiteScores) : 0;
    const uppers = [...new Set(cells.map((c) => c.upper))].sort((a, b) => a - b);
    const lowers = [...new Set(cells.map((c) => c.lower))].sort((a, b) => a - b);
    return { cells, uppers, lowers, minScore, maxScore };
  }, [rows, objective, inflationPct]);

  if (cells.length === 0) return null;

  const innerW = CHART_WIDTH - MARGIN.left - MARGIN.right;
  const innerH = CHART_HEIGHT - MARGIN.top - MARGIN.bottom;

  const minU = uppers[0];
  const maxU = uppers[uppers.length - 1];
  const minL = lowers[0];
  const maxL = lowers[lowers.length - 1];
  const spanU = Math.max(1e-6, maxU - minU);
  const spanL = Math.max(1e-6, maxL - minL);

  const xFor = (u: number) => MARGIN.left + ((u - minU) / spanU) * innerW;
  const yFor = (l: number) => MARGIN.top + (1 - (l - minL) / spanL) * innerH;

  // Cell size: take smallest gap between adjacent values along each axis.
  const stepU = uppers.length > 1
    ? Math.min(...uppers.slice(1).map((u, i) => u - uppers[i]))
    : 1;
  const stepL = lowers.length > 1
    ? Math.min(...lowers.slice(1).map((l, i) => l - lowers[i]))
    : 1;
  const cellW = (stepU / spanU) * innerW;
  const cellH = (stepL / spanL) * innerH;

  const scoreSpan = Math.max(1e-9, maxScore - minScore);
  const normalize = (s: number) => (isFinite(s) ? (s - minScore) / scoreSpan : 0);

  // Axis ticks: aim for ~6
  const tickCount = 6;
  const tick = (lo: number, hi: number) => {
    const out: number[] = [];
    for (let i = 0; i <= tickCount; i++) {
      out.push(lo + ((hi - lo) * i) / tickCount);
    }
    return out;
  };

  return (
    <div className="w-full overflow-x-auto">
      <svg
        width={CHART_WIDTH}
        height={CHART_HEIGHT}
        className="text-foreground"
        role="img"
        aria-label="SMA buffer 2D heatmap"
      >
        {/* Cells */}
        {cells.map((c, i) => {
          const x = xFor(c.upper) - cellW / 2;
          const y = yFor(c.lower) - cellH / 2;
          return (
            <rect
              key={i}
              x={x}
              y={y}
              width={Math.max(1, cellW)}
              height={Math.max(1, cellH)}
              fill={isFinite(c.score) ? valueToColor(normalize(c.score)) : "rgba(120,120,120,0.3)"}
              stroke={hovered === c ? "#fff" : "none"}
              strokeWidth={hovered === c ? 1.5 : 0}
              onMouseEnter={() => setHovered(c)}
              onMouseLeave={() => setHovered(null)}
              cursor="pointer"
            />
          );
        })}

        {/* Diagonal (upper == lower) line */}
        {(() => {
          const lo = Math.max(minU, minL);
          const hi = Math.min(maxU, maxL);
          if (hi <= lo) return null;
          return (
            <line
              x1={xFor(lo)}
              y1={yFor(lo)}
              x2={xFor(hi)}
              y2={yFor(hi)}
              stroke="rgba(255,255,255,0.55)"
              strokeDasharray="4 4"
              strokeWidth={1}
            />
          );
        })()}

        {/* Fine-search window outline */}
        {fineWindow && (
          <rect
            x={xFor(fineWindow.minU) - cellW / 2}
            y={yFor(fineWindow.maxL) - cellH / 2}
            width={Math.max(0, xFor(fineWindow.maxU) - xFor(fineWindow.minU) + cellW)}
            height={Math.max(0, yFor(fineWindow.minL) - yFor(fineWindow.maxL) + cellH)}
            fill="none"
            stroke="rgba(255,255,255,0.55)"
            strokeWidth={1.2}
          />
        )}

        {/* Highlight marker */}
        {highlight && (
          <circle
            cx={xFor(highlight.upper)}
            cy={yFor(highlight.lower)}
            r={6}
            fill="none"
            stroke="#fde047"
            strokeWidth={2}
          />
        )}

        {/* Axes */}
        <line
          x1={MARGIN.left}
          y1={MARGIN.top + innerH}
          x2={MARGIN.left + innerW}
          y2={MARGIN.top + innerH}
          stroke="currentColor"
          strokeOpacity={0.4}
        />
        <line
          x1={MARGIN.left}
          y1={MARGIN.top}
          x2={MARGIN.left}
          y2={MARGIN.top + innerH}
          stroke="currentColor"
          strokeOpacity={0.4}
        />

        {/* X ticks (upper buffer) */}
        {tick(minU, maxU).map((u, i) => (
          <g key={`xt-${i}`}>
            <line
              x1={xFor(u)}
              y1={MARGIN.top + innerH}
              x2={xFor(u)}
              y2={MARGIN.top + innerH + 4}
              stroke="currentColor"
              strokeOpacity={0.4}
            />
            <text
              x={xFor(u)}
              y={MARGIN.top + innerH + 18}
              fontSize={11}
              textAnchor="middle"
              fill="currentColor"
              opacity={0.75}
            >
              {u.toFixed(1)}%
            </text>
          </g>
        ))}

        {/* Y ticks (lower buffer) */}
        {tick(minL, maxL).map((l, i) => (
          <g key={`yt-${i}`}>
            <line
              x1={MARGIN.left - 4}
              y1={yFor(l)}
              x2={MARGIN.left}
              y2={yFor(l)}
              stroke="currentColor"
              strokeOpacity={0.4}
            />
            <text
              x={MARGIN.left - 6}
              y={yFor(l) + 4}
              fontSize={11}
              textAnchor="end"
              fill="currentColor"
              opacity={0.75}
            >
              {l.toFixed(1)}%
            </text>
          </g>
        ))}

        {/* Axis labels */}
        <text
          x={MARGIN.left + innerW / 2}
          y={CHART_HEIGHT - 12}
          fontSize={12}
          textAnchor="middle"
          fill="currentColor"
          opacity={0.85}
        >
          Upper buffer (buy threshold)
        </text>
        <text
          transform={`rotate(-90 ${14} ${MARGIN.top + innerH / 2})`}
          x={14}
          y={MARGIN.top + innerH / 2}
          fontSize={12}
          textAnchor="middle"
          fill="currentColor"
          opacity={0.85}
        >
          Lower buffer (sell threshold)
        </text>

        {/* Colorbar */}
        <ColorBar
          x={MARGIN.left + innerW + 16}
          y={MARGIN.top}
          height={innerH}
          minScore={minScore}
          maxScore={maxScore}
          objective={objective}
        />
      </svg>

      {/* Tooltip */}
      {hovered && (
        <div className="mt-2 text-xs text-muted">
          <span className="font-semibold text-foreground">
            Upper {hovered.upper.toFixed(2)}% / Lower {hovered.lower.toFixed(2)}%
          </span>
          {" · "}
          Score: {formatScore(hovered.score, objective)}
          {" · "}
          Avg CAGR (real): {formatPercent((hovered.row.avgReturn ?? 0) - inflationPct)}
          {" · "}
          Worst DD: {formatPercent(hovered.row.biggestMaxDrawdown ?? 0)}
          {" · "}
          Stage: {hovered.row.stage}
        </div>
      )}
    </div>
  );
}

function formatScore(score: number, objective: ObjectiveKey): string {
  if (!isFinite(score)) return "—";
  if (objective === "sharpeLike") return score.toFixed(2);
  if (objective === "score") {
    // Heuristic score is unit-less and can grow large; format compactly.
    const abs = Math.abs(score);
    if (abs >= 1000) return score.toExponential(2);
    return score.toFixed(2);
  }
  return formatPercent(score);
}

function ColorBar({
  x,
  y,
  height,
  minScore,
  maxScore,
  objective,
}: {
  x: number;
  y: number;
  height: number;
  minScore: number;
  maxScore: number;
  objective: ObjectiveKey;
}) {
  const stops = 24;
  return (
    <g>
      {Array.from({ length: stops }).map((_, i) => {
        const t = i / (stops - 1);
        const h = height / stops;
        return (
          <rect
            key={i}
            x={x}
            y={y + height - (i + 1) * h}
            width={14}
            height={h + 0.5}
            fill={valueToColor(t)}
          />
        );
      })}
      <text x={x + 18} y={y + 8} fontSize={11} fill="currentColor" opacity={0.75}>
        {formatScore(maxScore, objective)}
      </text>
      <text x={x + 18} y={y + height} fontSize={11} fill="currentColor" opacity={0.75}>
        {formatScore(minScore, objective)}
      </text>
    </g>
  );
}
