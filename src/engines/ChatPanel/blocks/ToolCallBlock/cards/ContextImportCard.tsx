import { Link2, Pin } from "lucide-react";
import React from "react";

import type { ContextImportCardData } from "../types";
import { ToolResultCardFrame } from "./ToolResultCardFrame";

interface ContextImportCardProps {
  card: ContextImportCardData;
}

const ContextImportCard: React.FC<ContextImportCardProps> = ({ card }) => {
  const title = card.title || card.sourceId;
  return (
    <ToolResultCardFrame>
      <div className="flex items-start gap-2">
        <span className="mt-0.5 shrink-0 text-primary-6">
          <Link2 size={13} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="chat-block-content truncate font-medium text-text-1">
              {title}
            </span>
            {card.pinned && (
              <Pin size={12} className="shrink-0 text-primary-6" />
            )}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1 text-xs text-text-4">
            {(card.sourceChips?.length
              ? card.sourceChips
              : [card.namespace]
            ).map((chip) => (
              <span
                key={chip}
                className="rounded bg-fill-3 px-1.5 py-0.5 font-mono text-[10px]"
              >
                {chip}
              </span>
            ))}
            {card.tokenEstimate !== undefined && (
              <span className="rounded bg-fill-2 px-1.5 py-0.5 text-[10px]">
                {card.tokenEstimate} tokens est.
              </span>
            )}
            {card.snapshotId && (
              <span className="truncate rounded bg-fill-2 px-1.5 py-0.5 font-mono text-[10px]">
                {card.snapshotId.slice(0, 8)}
              </span>
            )}
          </div>
          {card.debugStats?.length ? (
            <div className="mt-2 grid grid-cols-2 gap-1 text-[10px] text-text-4 sm:grid-cols-3">
              {card.debugStats.map((stat) => (
                <div key={stat.label} className="rounded bg-fill-2 px-1.5 py-1">
                  <span className="text-text-5 mr-1 uppercase tracking-wide">
                    {stat.label}
                  </span>
                  <span className="font-mono text-text-3">{stat.value}</span>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </ToolResultCardFrame>
  );
};

ContextImportCard.displayName = "ContextImportCard";

export default ContextImportCard;
