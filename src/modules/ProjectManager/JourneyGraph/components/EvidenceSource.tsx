import React from "react";

import type { JourneyEvidence } from "../viewModel";

export const EvidenceSource: React.FC<JourneyEvidence> = ({ evidenceClass, sourceRef }) => (
  <span className="inline-flex min-w-0 items-center gap-1 text-[11px] text-text-3" data-testid="journey-evidence">
    <span className="rounded border border-border-2 px-1 py-px" data-testid="journey-evidence-class">{evidenceClass}</span>
    <a className="truncate text-primary-6 hover:underline" data-testid="journey-source-ref" href={`#journey-source-${encodeURIComponent(sourceRef)}`} title={sourceRef}>Source: {sourceRef}</a>
  </span>
);
