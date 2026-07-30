import React from "react";

import type { BranchesViewModel } from "../viewModel";
import { EvidenceSource } from "./EvidenceSource";

export const BranchesGraph: React.FC<{ viewModel: BranchesViewModel }> = ({ viewModel }) => <section aria-label="Journey branches" data-testid="branches-graph">{viewModel.links.length === 0 ? <p className="text-xs text-text-3">No factual branch, resume, or compaction edges.</p> : <div className="space-y-3">{viewModel.nodes.map((node) => <div key={node.id} className="border border-border-2 p-2 text-xs" data-testid="branch-node"><div className="font-medium text-text-1">{node.kind}: {node.title}</div><EvidenceSource evidenceClass={node.evidenceClass} sourceRef={node.sourceRef} /></div>)}<div className="border-t border-border-2 pt-2">{viewModel.links.map((link) => <div key={`${link.kind}-${link.from}-${link.to}-${link.sourceRef}`} className="py-1 text-xs" data-testid="branch-link"><span className="font-medium">{link.kind}</span>: {link.from} to {link.to} <EvidenceSource evidenceClass={link.evidenceClass} sourceRef={link.sourceRef} /></div>)}</div></div>}</section>;
