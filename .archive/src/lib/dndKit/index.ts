/**
 * dnd-kit Library Exports
 *
 * Centralized exports for dnd-kit with WebView-aware utilities.
 * This replaces @hello-pangea/dnd with better support for Tauri/WKWebView.
 */

// Re-export core dnd-kit functionality
export {
  DndContext,
  DragOverlay,
  closestCenter,
  closestCorners,
  rectIntersection,
  pointerWithin,
  useDndMonitor,
  useDraggable,
  useDroppable,
} from "@dnd-kit/core";

export type {
  Active,
  DndContextProps,
  DragCancelEvent,
  DragEndEvent,
  DragMoveEvent,
  DragOverEvent,
  DragStartEvent,
  DroppableContainer as DroppableContainerType,
  Over,
  UniqueIdentifier,
} from "@dnd-kit/core";

// Re-export sortable functionality
export {
  SortableContext,
  arrayMove,
  horizontalListSortingStrategy,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";

export type { SortableContextProps, SortingStrategy } from "@dnd-kit/sortable";

// Re-export utilities
export { CSS } from "@dnd-kit/utilities";

// Re-export modifiers
export {
  restrictToFirstScrollableAncestor,
  restrictToParentElement,
  restrictToVerticalAxis,
  restrictToWindowEdges,
} from "@dnd-kit/modifiers";

// Export our custom utilities
export {
  getUiScaleFromCssVar,
  scaleAwareModifier,
  useWebViewSensors,
} from "./utils";

export type { WebViewSensorOptions } from "./utils";

// Export reusable components
export {
  DragOverlayItem,
  DroppableContainer,
  SortableItem,
} from "./components";

export type {
  DragOverlayItemProps,
  DroppableContainerProps,
  DroppableContainerRenderProps,
  SortableItemProps,
  SortableItemRenderProps,
} from "./components";
