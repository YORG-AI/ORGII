/**
 * Utils barrel export for useGlobalDragDrop
 */
export { hasVisibleChatDropTarget } from "./routeUtils";
export {
  isInternalDrag,
  isDropInsideChatDropTarget,
  getChatDropTargetId,
  createPreventDefaults,
} from "./dragDetection";
export {
  extractFilePath,
  extractFilePathAsync,
  type ExtractedFilePath,
} from "./filePathExtraction";
