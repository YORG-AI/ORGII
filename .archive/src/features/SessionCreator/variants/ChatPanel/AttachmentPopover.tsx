import React, { memo } from "react";

import { SURFACE_TOKENS } from "@src/config/surfaceTokens";

export interface AttachmentPanelProps {
  open: boolean;
  className?: string;
}

const AttachmentPanel: React.FC<AttachmentPanelProps> = memo(
  ({ open, className = "" }) => {
    if (!open) return null;

    return (
      <div
        data-testid="session-creator-attachment-panel"
        className={`flex w-full flex-col rounded-[12px] border border-solid border-border-2 ${SURFACE_TOKENS.surface} ${className}`}
      >
        <div className="flex h-32 items-center justify-center p-3 text-[12px] text-text-3">
          Attachments
        </div>
      </div>
    );
  }
);

AttachmentPanel.displayName = "AttachmentPanel";

export default AttachmentPanel;
