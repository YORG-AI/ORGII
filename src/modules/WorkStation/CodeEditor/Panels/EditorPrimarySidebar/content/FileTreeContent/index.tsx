/**
 * WorkStation FileTreeContent public entry point.
 *
 * Wraps the local implementation, injecting the WorkStation-specific
 * stickyBgClass from the primary sidebar surface token hook.
 */
import React, { forwardRef, memo } from "react";

import { usePrimarySidebarSurface } from "@src/modules/WorkStation/shared/hooks/usePrimarySidebarSurface";

import { FileTreeContent as FileTreeContentImpl } from "./FileTreeContentImpl";
import type { FileTreeContentHandle, FileTreeContentProps } from "./types";

export type { FileTreeContentHandle } from "./types";

const FileTreeContentInner = forwardRef<
  FileTreeContentHandle,
  FileTreeContentProps
>((props, ref) => {
  const { stickyBgClass } = usePrimarySidebarSurface();
  return (
    <FileTreeContentImpl ref={ref} {...props} stickyBgClass={stickyBgClass} />
  );
});

FileTreeContentInner.displayName = "FileTreeContent";

export const FileTreeContent = memo(FileTreeContentInner);
FileTreeContent.displayName = "FileTreeContent";
