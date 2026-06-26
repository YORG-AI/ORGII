/**
 * HeatmapGrid — Shared responsive heatmap component.
 *
 * Used by CommitDotGraph, FocusHeatmap, and CodingActivityView.
 * Dynamically sizes cells to fill the container width, caps at MAX_CELL_SIZE,
 * and intelligently skips x-axis labels that would overlap.
 */
import React, {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type { CliAgentType } from "@src/api/types/keys";
import { CHART_TOOLTIP } from "@src/components/Chart";
import { resolveSessionRowIcon } from "@src/util/session/sessionSidebarRow";

import { getHeatmapColor } from "../views/CodingProfileView/config";

// ============================================
// Types
// ============================================

export interface HeatmapGridCellSession {
  sessionId: string;
  name: string;
  userInput?: string;
  cliAgentType?: CliAgentType;
  agentIconId?: string;
}

export interface HeatmapGridCell {
  xIndex: number;
  yIndex: number;
  count: number;
  label: string;
  sessions?: HeatmapGridCellSession[];
}

export interface HeatmapGridLabel {
  label: string;
  index: number;
}

export interface HeatmapGridProps {
  cells: HeatmapGridCell[];
  xCount: number;
  yCount: number;
  xLabels: HeatmapGridLabel[];
  yLabels: HeatmapGridLabel[];
  maxCount: number;
  unit: string;
  yLabelWidth?: number;
}

// ============================================
// Constants
// ============================================

const MAX_CELL_SIZE = 18;
const MIN_CELL_SIZE = 8;
const CELL_GAP = 3;
const CELL_RADIUS = 2;
const DEFAULT_Y_LABEL_WIDTH = 32;
const HEADER_HEIGHT = 18;
const MIN_X_LABEL_GAP_PX = 44;
const LEGEND_LEVELS = [0, 0.25, 0.5, 0.75, 1] as const;

// ============================================
// Component
// ============================================

const HeatmapGrid: React.FC<HeatmapGridProps> = memo(
  ({
    cells,
    xCount,
    yCount,
    xLabels,
    yLabels,
    maxCount,
    unit,
    yLabelWidth = DEFAULT_Y_LABEL_WIDTH,
  }) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const [containerWidth, setContainerWidth] = useState(0);
    const [hoveredCell, setHoveredCell] = useState<HeatmapGridCell | null>(
      null
    );

    useEffect(() => {
      const el = containerRef.current;
      if (!el) return;

      const observer = new ResizeObserver((entries) => {
        const entry = entries[0];
        if (entry) setContainerWidth(entry.contentRect.width);
      });
      observer.observe(el);
      return () => observer.disconnect();
    }, []);

    const cellSize = useMemo(() => {
      if (!containerWidth || !xCount) return MAX_CELL_SIZE;
      const available = containerWidth - yLabelWidth;
      const computed = Math.floor(available / xCount) - CELL_GAP;
      return Math.max(MIN_CELL_SIZE, Math.min(MAX_CELL_SIZE, computed));
    }, [containerWidth, xCount, yLabelWidth]);

    const cellStep = cellSize + CELL_GAP;

    const cellIndex = useMemo(() => {
      const map = new Map<string, HeatmapGridCell>();
      for (const cell of cells) {
        map.set(`${cell.xIndex}-${cell.yIndex}`, cell);
      }
      return map;
    }, [cells]);

    const visibleXLabels = useMemo(() => {
      const filtered: HeatmapGridLabel[] = [];
      let lastPx = -Infinity;
      for (const label of xLabels) {
        const px = label.index * cellStep;
        if (px - lastPx >= MIN_X_LABEL_GAP_PX) {
          filtered.push(label);
          lastPx = px;
        }
      }
      return filtered;
    }, [xLabels, cellStep]);

    const svgWidth = yLabelWidth + xCount * cellStep;
    const svgHeight = HEADER_HEIGHT + yCount * cellStep;

    const handleMouseMove = useCallback(
      (event: React.MouseEvent<SVGSVGElement>) => {
        const svg = event.currentTarget;
        const rect = svg.getBoundingClientRect();
        const mouseX = event.clientX - rect.left - yLabelWidth;
        const mouseY = event.clientY - rect.top - HEADER_HEIGHT;

        if (mouseX < 0 || mouseY < 0) {
          setHoveredCell(null);
          return;
        }

        const xIdx = Math.floor(mouseX / cellStep);
        const yIdx = Math.floor(mouseY / cellStep);

        if (xIdx < 0 || xIdx >= xCount || yIdx < 0 || yIdx >= yCount) {
          setHoveredCell(null);
          return;
        }

        setHoveredCell(cellIndex.get(`${xIdx}-${yIdx}`) ?? null);
      },
      [yLabelWidth, cellStep, xCount, yCount, cellIndex]
    );

    const handleMouseLeave = useCallback(() => setHoveredCell(null), []);

    const pluralUnit = useMemo(
      () => (unit.endsWith("s") ? unit : unit + "s"),
      [unit]
    );

    if (!containerWidth) {
      return <div ref={containerRef} className="h-24 w-full" />;
    }

    return (
      <div ref={containerRef} className="relative w-full">
        <svg
          width={svgWidth}
          height={svgHeight + 52}
          className="block"
          onMouseMove={handleMouseMove}
          onMouseLeave={handleMouseLeave}
        >
          {visibleXLabels.map((label, idx) => (
            <text
              key={`x-${label.index}-${idx}`}
              x={yLabelWidth + label.index * cellStep}
              y={12}
              className="fill-text-2"
              fontSize={10}
            >
              {label.label}
            </text>
          ))}

          {yLabels.map((label, idx) => (
            <text
              key={`y-${label.index}-${idx}`}
              x={yLabelWidth - 6}
              y={HEADER_HEIGHT + label.index * cellStep + cellSize / 2}
              textAnchor="end"
              dominantBaseline="central"
              className="fill-text-2"
              fontSize={10}
            >
              {label.label}
            </text>
          ))}

          {cells.map((cell) => {
            const isHovered =
              hoveredCell?.xIndex === cell.xIndex &&
              hoveredCell?.yIndex === cell.yIndex;
            return (
              <rect
                key={`${cell.xIndex}-${cell.yIndex}`}
                x={yLabelWidth + cell.xIndex * cellStep}
                y={HEADER_HEIGHT + cell.yIndex * cellStep}
                width={cellSize}
                height={cellSize}
                rx={CELL_RADIUS}
                ry={CELL_RADIUS}
                fill={getHeatmapColor(cell.count, maxCount)}
                stroke={isHovered ? "var(--color-border-3)" : "transparent"}
                strokeWidth={isHovered ? 3 : 0}
              />
            );
          })}
        </svg>

        {hoveredCell && (
          <div
            className="pointer-events-none absolute z-10"
            style={{
              left: yLabelWidth + hoveredCell.xIndex * cellStep + cellSize / 2,
              top:
                HEADER_HEIGHT +
                hoveredCell.yIndex * cellStep +
                cellSize +
                CELL_GAP,
              transform: "translateX(-50%)",
              ...CHART_TOOLTIP.content,
            }}
          >
            <p
              style={{
                ...CHART_TOOLTIP.label,
                fontSize: 11,
                fontWeight: 500,
                marginBottom: 4,
              }}
            >
              {hoveredCell.label} · {hoveredCell.count.toLocaleString()}{" "}
              {hoveredCell.count === 1 ? unit : pluralUnit}
            </p>
            {hoveredCell.sessions?.length ? (
              <div className="flex max-w-[220px] flex-col gap-1">
                {hoveredCell.sessions.slice(0, 5).map((session) => {
                  const SessionIcon = resolveSessionRowIcon({
                    session_id: session.sessionId,
                    user_input: session.userInput,
                    cliAgentType: session.cliAgentType,
                    agentIconId: session.agentIconId,
                  });
                  return (
                    <div
                      key={session.sessionId}
                      className="flex min-w-0 items-center gap-1.5 text-[11px] leading-5 text-text-1"
                    >
                      <SessionIcon
                        size={12}
                        strokeWidth={1.75}
                        className="shrink-0 text-text-2"
                      />
                      <span className="truncate">{session.name}</span>
                    </div>
                  );
                })}
                {hoveredCell.sessions.length > 5 && (
                  <div className="text-[11px] leading-5 text-text-2">
                    +{hoveredCell.sessions.length - 5}
                  </div>
                )}
              </div>
            ) : (
              <p
                style={{
                  ...CHART_TOOLTIP.item,
                  fontSize: 11,
                  lineHeight: "20px",
                }}
              >
                <span style={{ color: "var(--color-text-1)" }}>
                  {hoveredCell.count}
                </span>{" "}
                {hoveredCell.count === 1 ? unit : pluralUnit}
              </p>
            )}
          </div>
        )}

        <div className="mt-1 flex items-center justify-end gap-1 text-[10px] text-text-2">
          <span>Less</span>
          {LEGEND_LEVELS.map((level, idx) => (
            <svg key={idx} width={cellSize} height={cellSize}>
              <rect
                width={cellSize}
                height={cellSize}
                rx={CELL_RADIUS}
                ry={CELL_RADIUS}
                fill={getHeatmapColor(level * maxCount, maxCount)}
              />
            </svg>
          ))}
          <span>More</span>
        </div>
      </div>
    );
  }
);

HeatmapGrid.displayName = "HeatmapGrid";

export default HeatmapGrid;
