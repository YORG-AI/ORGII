/**
 * FileTypeIcon Component
 *
 * Displays the appropriate SVG icon based on file type. Icons are asset URLs
 * drawn through `<img>` so the glyph set costs no JS modules; the monochrome
 * icon setting still applies because it is a CSS filter on the class.
 * Uses memoization to prevent unnecessary re-renders.
 *
 * @example
 * ```tsx
 * <FileTypeIcon fileName="app.tsx" />
 * <FileTypeIcon fileName="readme.md" size="large" />
 * <FileTypeIcon type="python" size="small" />
 * ```
 */
import React, { memo } from "react";

import { DECORATIVE_ICON_CLASS } from "@src/config/appearance/decorativeIcons";

import { DocumentIcon, ICON_MAP } from "./config";
import { type FileTypeIconProps, SIZE_STYLES } from "./types";
import { getFileTypeFromName } from "./utils";

// Re-export types for external use
export type { FileTypeIconProps } from "./types";
export { getFileTypeFromName } from "./utils";

/**
 * File type icon component
 */
const FileTypeIcon: React.FC<FileTypeIconProps> = memo(
  ({ fileName, type: propType, className = "", size = "medium" }) => {
    const type = propType || getFileTypeFromName(fileName);
    const { width, height } = SIZE_STYLES[size] || SIZE_STYLES.medium;
    const iconSrc = type === "other" ? undefined : ICON_MAP[type];
    // These glyphs carry their own palettes, so they are what the monochrome
    // icon setting acts on.
    const iconClassName = `${DECORATIVE_ICON_CLASS} ${className}`.trim();

    return (
      <img
        src={iconSrc ?? DocumentIcon}
        width={width}
        height={height}
        className={iconClassName}
        alt=""
        aria-hidden="true"
        draggable={false}
      />
    );
  }
);

FileTypeIcon.displayName = "FileTypeIcon";

export default FileTypeIcon;
