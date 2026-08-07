import type { ReactNode } from "react";

import { FileTreeHoverPreview } from "@src/components/FileTreePreview/exports";

interface EventFileHoverPreviewProps {
  path?: string | null;
  repoPath?: string;
  children: ReactNode;
}

const EventFileHoverPreview: React.FC<EventFileHoverPreviewProps> = ({
  path,
  repoPath,
  children,
}) => {
  if (!path) return children;

  return (
    <FileTreeHoverPreview
      path={path}
      itemType="file"
      repoPath={repoPath}
      as="div"
      display="block"
      placement="bottom"
      showDelayMs={750}
    >
      {children}
    </FileTreeHoverPreview>
  );
};

EventFileHoverPreview.displayName = "EventFileHoverPreview";

export default EventFileHoverPreview;
