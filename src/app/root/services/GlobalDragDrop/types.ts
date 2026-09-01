/**
 * GlobalDragDrop Types
 */

/** Dropped file information */
export interface DroppedFileInfo {
  id: string;
  name: string;
  path: string;
  type: "file" | "folder";
  browserFile?: File;
  dropTargetId?: string;
}
