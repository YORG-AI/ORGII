/**
 * GlobalDragDrop Component
 *
 * Global drag-and-drop handler. Behavior is derived from the drop target:
 * - Drop files onto a visible composer input → add as chat context.
 */
import React, { useEffect } from "react";

import "./index.scss";
import { useGlobalDragDrop } from "./useGlobalDragDrop/index";

const GlobalDragDrop: React.FC = () => {
  const { isDragging } = useGlobalDragDrop();

  useEffect(() => {
    document.body.dataset.chatFileDragging = isDragging ? "true" : "false";
    return () => {
      delete document.body.dataset.chatFileDragging;
    };
  }, [isDragging]);

  return null;
};

export default GlobalDragDrop;
