/**
 * SectionDescription
 *
 * Semantic supporting copy for structured content surfaces. It centralizes
 * the SectionLayout description token and paragraph reset so consumers do not
 * rebuild the same text element locally.
 */
import React, { memo } from "react";

import { SECTION_DESCRIPTION_CLASSES } from "./tokens";

export interface SectionDescriptionProps extends React.HTMLAttributes<HTMLParagraphElement> {
  children?: React.ReactNode;
}

const SectionDescription: React.FC<SectionDescriptionProps> = memo(
  ({ children, className = "", ...props }) => (
    <p
      {...props}
      className={`m-0 leading-5 ${SECTION_DESCRIPTION_CLASSES} ${className}`.trim()}
    >
      {children}
    </p>
  )
);

SectionDescription.displayName = "SectionDescription";

export default SectionDescription;
