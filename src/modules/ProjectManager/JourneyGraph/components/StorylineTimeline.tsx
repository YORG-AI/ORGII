import React from "react";

import type { StorylineViewModel } from "../viewModel";
import { EvidenceSource } from "./EvidenceSource";

export const StorylineTimeline: React.FC<{ viewModel: StorylineViewModel }> = ({ viewModel }) => (
  <section aria-label="Storyline timeline" className="space-y-4" data-testid="storyline-timeline">
    <p className="text-xs text-text-3">Real-time x-axis uses display timestamps only. Compressed spans are labeled; connectors are factual edges.</p>
    {viewModel.lanes.map((lane) => <div key={lane.id} className="overflow-x-auto border-l-2 border-border-2 pl-3"><h3 className="mb-2 text-sm font-medium text-text-1">Agent / session lane: {lane.label}</h3><div className="mb-2 min-w-max border-b border-border-2 pb-1 text-[11px] text-text-3">Real-time x-axis -&gt;</div><ol className="flex min-w-max items-stretch gap-2">{lane.milestones.map((milestone) => <React.Fragment key={milestone.id}><li className="w-52 shrink-0 border border-border-2 p-2 text-xs" data-testid="storyline-milestone"><div className="font-medium text-text-1">{milestone.kind}: {milestone.title}</div><div className="text-text-3">{milestone.displayTimestamp}{milestone.sequence !== null ? ` · turn ${milestone.sequence}` : ""}</div><EvidenceSource evidenceClass={milestone.evidenceClass} sourceRef={milestone.sourceRef} /></li>{lane.gaps.filter((gap) => gap.fromTimestamp === milestone.displayTimestamp).map((gap) => <li key={`${gap.fromTimestamp}-${gap.toTimestamp}`} className="flex w-40 shrink-0 items-center border-x border-dashed border-warning-6 px-2 text-xs text-warning-6" data-testid="storyline-idle-gap">Idle compression: {Math.round(gap.durationMs / 60000)} min</li>)}</React.Fragment>)}</ol></div>)}
    {viewModel.unpositioned.length > 0 && <div className="border border-border-2 p-3"><h3 className="text-sm font-medium text-text-1">Facts without display time</h3>{viewModel.unpositioned.map((item) => <div key={item.id} className="mt-2 text-xs"><span>{item.kind}: {item.title} </span><EvidenceSource evidenceClass={item.evidenceClass} sourceRef={item.sourceRef} /></div>)}</div>}
    <div className="space-y-1" aria-label="Factual connectors">{viewModel.connectors.map((connector) => <div key={`${connector.kind}-${connector.from}-${connector.to}-${connector.sourceRef}`} className="text-xs text-text-2" data-testid="storyline-connector">{connector.kind}: {connector.from} to {connector.to} <EvidenceSource evidenceClass={connector.evidenceClass} sourceRef={connector.sourceRef} /></div>)}</div>
  </section>
);
