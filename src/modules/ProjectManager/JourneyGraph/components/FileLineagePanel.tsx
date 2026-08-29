import React from "react";

import type { FileLineageViewModel } from "../viewModel";
import { EvidenceSource } from "./EvidenceSource";

export const FileLineagePanel: React.FC<{
  viewModel: FileLineageViewModel;
}> = ({ viewModel }) => (
  <section aria-label="File lineage" data-testid="file-lineage-panel">
    {viewModel.links.length === 0 ? (
      <p className="text-xs text-text-3">
        No factual produced or modified file edges.
      </p>
    ) : (
      <div className="space-y-3">
        <div>
          {viewModel.files.map((file) => (
            <div
              key={file.id}
              className="border border-border-2 p-2 text-xs"
              data-testid="file-lineage-file"
            >
              <div className="font-medium text-text-1">File: {file.title}</div>
              <EvidenceSource
                evidenceClass={file.evidenceClass}
                sourceRef={file.sourceRef}
              />
            </div>
          ))}
        </div>
        <div>
          {viewModel.adjacentNodes.map((node) => (
            <div key={node.id} className="py-1 text-xs">
              {node.kind}: {node.title}{" "}
              <EvidenceSource
                evidenceClass={node.evidenceClass}
                sourceRef={node.sourceRef}
              />
            </div>
          ))}
        </div>
        <div className="border-t border-border-2 pt-2">
          {viewModel.links.map((link) => (
            <div
              key={`${link.kind}-${link.from}-${link.to}-${link.sourceRef}`}
              className="py-1 text-xs"
              data-testid="file-lineage-link"
            >
              {link.kind}: {link.from} to {link.to}{" "}
              <EvidenceSource
                evidenceClass={link.evidenceClass}
                sourceRef={link.sourceRef}
              />
            </div>
          ))}
        </div>
      </div>
    )}
  </section>
);
