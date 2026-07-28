import React, { memo } from "react";

import Markdown from "@src/components/MarkDown";

export const ReplayMarkdown: React.FC<{ content: string }> = memo(
  ({ content }) => (
    <Markdown
      textContent={content}
      useChatCodeBlock={true}
      enableFileNavigation={true}
      skipPreprocess={false}
      disableCanvasInline={true}
    />
  )
);
ReplayMarkdown.displayName = "ReplayMarkdown";
