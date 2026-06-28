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
            {card.pinned && <Pin size={12} className="shrink-0 text-primary-6" />}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-text-4">
            <span className="rounded bg-fill-3 px-1.5 py-0.5 font-mono text-[10px]">
              {card.namespace}
            </span>
            <span>·</span>
            <span>{card.sourceKind.replace(/_/g, " ")}</span>
            {card.tokenEstimate !== undefined && (
              <>
                <span>·</span>
                <span>{card.tokenEstimate} tokens est.</span>
              </>
            )}
            {card.snapshotId && (
              <>
                <span>·</span>
                <span className="truncate font-mono text-[10px]">
                  {card.snapshotId.slice(0, 8)}
                </span>
              </>
            )}
          </div>
        </div>
      </div>
    </ToolResultCardFrame>
  );
};

ContextImportCard.displayName = "ContextImportCard";

export default ContextImportCard;
