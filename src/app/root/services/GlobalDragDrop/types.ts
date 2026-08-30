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

/** IDE file drop information */
export interface IdeFileDropInfo {
  path: string;
  name: string;
  extension?: string;
  language?: string;
}
