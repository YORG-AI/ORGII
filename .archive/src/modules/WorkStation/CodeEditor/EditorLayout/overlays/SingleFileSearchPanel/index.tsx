/**
 * SingleFileSearchPanel Component
 *
 * Floating overlay panel for file search with fuzzy matching.
 * Shows loading spinner and explicit close button.
 * (This is a file picker like Ctrl+P, not a code search panel)
 */
import React, { memo } from "react";

import {
  BaseFileSearchPanel,
  type FileSearchPanelProps,
} from "../FileSearchPanel/BaseFileSearchPanel";

export const SingleFileSearchPanel: React.FC<FileSearchPanelProps> = memo(
  (props) => {
    return (
      <BaseFileSearchPanel {...props} showLoadingSpinner showCloseButton />
    );
  }
);

SingleFileSearchPanel.displayName = "SingleFileSearchPanel";

export default SingleFileSearchPanel;
