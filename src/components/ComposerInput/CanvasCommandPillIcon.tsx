import { Layout } from "lucide-react";
import React, { memo } from "react";

import { EDITOR_FILE_PILL_TEXT_COLOR, PILL_SIZE } from "@src/config/pillTokens";

export function isCanvasCommandPillPath(path: string): boolean {
  return path.trim().toLowerCase() === "/canvas";
}

const CanvasCommandPillIcon: React.FC = memo(() => (
  <Layout
    size={PILL_SIZE.iconSize}
    strokeWidth={1.75}
    style={{ color: EDITOR_FILE_PILL_TEXT_COLOR }}
  />
));
CanvasCommandPillIcon.displayName = "CanvasCommandPillIcon";

export default CanvasCommandPillIcon;
