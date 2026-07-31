import React from "react";

import type { StorylineViewModel } from "../viewModel";
import { EvidenceSource } from "./EvidenceSource";
import {
  CURVE_KINDS,
  LANE_HEIGHT,
  LANE_LABEL_WIDTH,
  PAD_LEFT,
  PAD_TOP,
  formatDuration,
  formatTick,
  layoutStoryline,
  parseTimestampMs,
} from "../timelineLayout";

/** Marker color per node kind (dark-theme harmonic palette). */
const KIND_COLOR: Record<string, string> = {
  session: "#5EB7E6",
  turn: "#8BA3FF",
  checkpoint: "#55C6B1",
  artifact: "#E2B357",
  commit: "#6FC98B",
};
const CURVE_COLOR: Record<string, string> = {
  forkedFrom: "#C79BF2",
  resumedFrom: "#EC8FB0",
  compactedTo: "#A9C05C",
};
const CURVE_DASH: Record<string, string> = {
  forkedFrom: "",
  resumedFrom: "5 4",
  compactedTo: "2 4",
};

const CARD_WIDTH = 156;
const CARD_HEIGHT = 52;

export const StorylineTimeline: React.FC<{ viewModel: StorylineViewModel }> = ({ viewModel }) => {
  const layout = layoutStoryline(viewModel);
  const { axis, lanes, curves, uncurved, unpositioned } = layout;

  // Sample up to 6 ticks evenly across the compressed axis.
  const tickStep = Math.max(1, Math.ceil(axis.points.length / 6));
  const ticks = axis.points.filter((_, index) => index % tickStep === 0);

  return (
    <section aria-label="Storyline timeline" className="space-y-4" data-testid="storyline-timeline">
      <p className="text-xs text-text-3">
        Real-time x-axis uses display timestamps only; long idle spans are compressed and labeled.
        Connector curves are factual edges (forkedFrom / resumedFrom / compactedTo).
      </p>

      <div className="overflow-x-auto">
        <div className="relative" style={{ width: layout.totalWidth, height: layout.totalHeight }}>
          {/* Lane labels (fixed left column). */}
          {lanes.map(({ lane, y }) => (
            <div
              key={lane.id}
              className="absolute top-0 truncate pr-2 text-xs font-medium text-text-2"
              style={{ left: 0, top: y + LANE_HEIGHT / 2 - 8, width: LANE_LABEL_WIDTH - 8 }}
              data-testid="storyline-lane"
            >
              {lane.label}
            </div>
          ))}

          {/* SVG layer: idle bands, baselines, markers, curves, fade tails. */}
          <svg
            className="absolute top-0"
            style={{ left: LANE_LABEL_WIDTH }}
            width={layout.totalWidth - LANE_LABEL_WIDTH}
            height={layout.totalHeight}
            role="img"
            aria-label="Storyline timeline lanes"
          >
            {/* Idle compression bands (global: any gap above the idle threshold). */}
            {axis.idleBands.map((band) => (
              <g key={`${band.fromComp}-${band.toComp}`} data-testid="storyline-idle-gap">
                <rect
                  x={PAD_LEFT + band.fromComp * axis.pxPerComp}
                  y={0}
                  width={Math.max(2, (band.toComp - band.fromComp) * axis.pxPerComp)}
                  height={layout.totalHeight}
                  fill="#E2B357"
                  fillOpacity={0.04}
                  stroke="#E2B357"
                  strokeOpacity={0.35}
                  strokeDasharray="4 4"
                  rx={3}
                />
                <text
                  x={PAD_LEFT + ((band.fromComp + band.toComp) / 2) * axis.pxPerComp}
                  y={PAD_TOP - 26}
                  textAnchor="middle"
                  fontSize={10}
                  fill="#E2B357"
                  fillOpacity={0.9}
                >
                  idle {formatDuration(band.ms)}
                </text>
              </g>
            ))}

            {/* Time ticks. */}
            {ticks.map((point) => (
              <g key={point.raw} data-testid="storyline-tick">
                <line
                  x1={PAD_LEFT + point.comp * axis.pxPerComp}
                  y1={PAD_TOP - 18}
                  x2={PAD_LEFT + point.comp * axis.pxPerComp}
                  y2={layout.totalHeight}
                  stroke="currentColor"
                  strokeOpacity={0.08}
                  strokeWidth={1}
                />
                <text
                  x={PAD_LEFT + point.comp * axis.pxPerComp}
                  y={PAD_TOP - 26}
                  fontSize={10}
                  fill="currentColor"
                  fillOpacity={0.55}
                  textAnchor="middle"
                >
                  {formatTick(point.raw)}
                </text>
              </g>
            ))}

            {/* Connector curves (factual edges only; endpoints must be placed). */}
            {curves.map(({ connector, path, fromX, fromY, toX, toY }) => (
              <g key={`${connector.kind}-${connector.from}-${connector.to}-${connector.sourceRef}`} data-testid="storyline-curve">
                <path
                  d={path}
                  fill="none"
                  stroke={CURVE_COLOR[connector.kind] ?? "#95A7E0"}
                  strokeWidth={1.6}
                  strokeDasharray={CURVE_DASH[connector.kind] ?? ""}
                  strokeOpacity={0.85}
                />
                <circle cx={toX} cy={toY} r={3} fill={CURVE_COLOR[connector.kind] ?? "#95A7E0"} stroke="none" />
              </g>
            ))}

            {/* Baselines + markers + fade tails per lane. */}
            {lanes.map(({ lane, y, placed, fadeTail }) => {
              const yCenter = y + LANE_HEIGHT / 2;
              const firstX = placed.length > 0 ? placed[0].x : PAD_LEFT;
              const lastX = placed.length > 0 ? placed[placed.length - 1].x : PAD_LEFT + 120;
              return (
                <g key={lane.id}>
                  <line
                    x1={firstX}
                    y1={yCenter}
                    x2={lastX}
                    y2={yCenter}
                    stroke="currentColor"
                    strokeOpacity={0.18}
                    strokeWidth={1.4}
                  />
                  {placed.map(({ milestone, x }) => (
                    <circle
                      key={milestone.id}
                      cx={x}
                      cy={yCenter}
                      r={4}
                      fill={KIND_COLOR[milestone.kind] ?? "#95A7E0"}
                      stroke="currentColor"
                      strokeOpacity={0.35}
                      strokeWidth={1}
                      data-testid="storyline-milestone"
                    />
                  ))}
                  {fadeTail && placed.length > 0 && (
                    <line
                      x1={lastX}
                      y1={yCenter}
                      x2={Math.min(lastX + 46, layout.totalWidth - LANE_LABEL_WIDTH)}
                      y2={yCenter}
                      stroke={KIND_COLOR[placed[placed.length - 1].milestone.kind] ?? "#95A7E0"}
                      strokeOpacity={0.22}
                      strokeWidth={1.4}
                      strokeDasharray="3 5"
                      data-testid="storyline-fade-tail"
                    />
                  )}
                </g>
              );
            })}
          </svg>

          {/* HTML layer: milestone label cards (kept above the SVG). */}
          {lanes.map(({ lane, y, placed }) =>
            placed
              .filter(({ showLabel }) => showLabel)
              .map(({ milestone, x }) => {
                const yCenter = y + LANE_HEIGHT / 2;
                const left = Math.min(Math.max(x - CARD_WIDTH / 2, 4), layout.totalWidth - LANE_LABEL_WIDTH - CARD_WIDTH - 4);
                return (
                  <div
                    key={milestone.id}
                    className="absolute rounded border border-border-2 bg-bg-1 px-2 py-1 text-[10px] leading-tight shadow-sm"
                    style={{ left: LANE_LABEL_WIDTH + left, top: yCenter - CARD_HEIGHT - 6, width: CARD_WIDTH, zIndex: 10 }}
                    data-testid="storyline-milestone-card"
                  >
                    <div className="truncate font-medium text-text-1">
                      <span style={{ color: KIND_COLOR[milestone.kind] ?? "#95A7E0" }}>●</span>{" "}
                      {milestone.kind}: {milestone.title}
                    </div>
                    <div className="truncate text-text-3">
                      {milestone.displayTimestamp}
                      {milestone.sequence !== null ? ` · turn ${milestone.sequence}` : ""}
                    </div>
                    <EvidenceSource evidenceClass={milestone.evidenceClass} sourceRef={milestone.sourceRef} />
                  </div>
                );
              })
          )}
        </div>
      </div>

      {/* Legend for the visual grammar. */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-text-3">
        {["forkedFrom", "resumedFrom", "compactedTo"].map((kind) => (
          <span key={kind} className="inline-flex items-center gap-1">
            <svg width={22} height={6}><line x1={0} y1={3} x2={22} y2={3} stroke={CURVE_COLOR[kind]} strokeWidth={2} strokeDasharray={CURVE_DASH[kind]} /></svg>
            {kind}
          </span>
        ))}
        <span className="inline-flex items-center gap-1">
          <svg width={22} height={6}><line x1={0} y1={3} x2={22} y2={3} stroke="currentColor" strokeOpacity={0.5} strokeWidth={2} strokeDasharray="3 5" /></svg>
          stale lane tail
        </span>
        <span className="inline-flex items-center gap-1">
          <svg width={22} height={6}><rect x={0} y={0} width={22} height={6} rx={2} fill="#E2B357" fillOpacity={0.25} stroke="#E2B357" strokeDasharray="4 4" /></svg>
          idle compression
        </span>
      </div>

      {/* Factual connectors that could not be drawn as curves. */}
      {uncurved.length > 0 && (
        <div className="space-y-1" aria-label="Factual connectors">
          {uncurved.map((connector) => (
            <div
              key={`${connector.kind}-${connector.from}-${connector.to}-${connector.sourceRef}`}
              className="text-xs text-text-2"
              data-testid="storyline-connector"
            >
              {connector.kind}: {connector.from} to {connector.to}{" "}
              <EvidenceSource evidenceClass={connector.evidenceClass} sourceRef={connector.sourceRef} />
            </div>
          ))}
        </div>
      )}

      {/* Facts without a display time stay visible but unpositioned (fail-closed). */}
      {unpositioned.length > 0 && (
        <div className="border border-border-2 p-3">
          <h3 className="text-sm font-medium text-text-1">Facts without display time</h3>
          {unpositioned.map((item) => (
            <div key={item.id} className="mt-2 text-xs">
              <span>
                {item.kind}: {item.title}{" "}
              </span>
              <EvidenceSource evidenceClass={item.evidenceClass} sourceRef={item.sourceRef} />
            </div>
          ))}
        </div>
      )}
    </section>
  );
};
