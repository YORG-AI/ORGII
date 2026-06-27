// Element Inspector - Drag-to-Reorder Functionality
// Provides drag-and-drop reordering of DOM elements

// Get drop position based on cursor location
const getDropPosition = (x, y) => {
  // Temporarily hide overlays to get accurate elementFromPoint
  const overlayDisplay = highlightOverlay.style.display;
  const selectedDisplay = selectedOverlay.style.display;
  const dropDisplay = dropIndicator.style.display;
  highlightOverlay.style.display = "none";
  selectedOverlay.style.display = "none";
  dropIndicator.style.display = "none";

  const el = document.elementFromPoint(x, y);

  highlightOverlay.style.display = overlayDisplay;
  selectedOverlay.style.display = selectedDisplay;
  dropIndicator.style.display = dropDisplay;

  if (!el || isOverlayElement(el) || isUndraggable(el)) return null;
  if (el === draggedElement) return null;
  if (draggedElement && draggedElement.contains(el)) return null;
  if (draggedElement && el.contains(draggedElement)) return null;

  const rect = el.getBoundingClientRect();
  const midY = rect.top + rect.height / 2;

  return {
    target: el,
    position: y < midY ? "before" : "after",
    rect: rect,
  };
};

// Show drop indicator at position
const showDropIndicator = (dropInfo) => {
  if (!dropInfo) {
    dropIndicator.style.display = "none";
    return;
  }

  const rect = dropInfo.rect;
  dropIndicator.style.left = rect.left + "px";
  dropIndicator.style.width = rect.width + "px";

  if (dropInfo.position === "before") {
    dropIndicator.style.top = rect.top - 1 + "px";
  } else {
    dropIndicator.style.top = rect.bottom - 2 + "px";
  }
  dropIndicator.style.display = "block";
};

// Hide drop indicator
const hideDropIndicator = () => {
  dropIndicator.style.display = "none";
};

// Move element to new position
const moveElement = (source, target, position) => {
  if (!source || !target || source === target) return false;

  try {
    if (position === "before") {
      target.parentNode.insertBefore(source, target);
    } else if (position === "after") {
      if (target.nextSibling) {
        target.parentNode.insertBefore(source, target.nextSibling);
      } else {
        target.parentNode.appendChild(source);
      }
    }

    // Update selection overlay to follow moved element
    if (source === selectedElement) {
      positionOverlay(selectedOverlay, source);
      window.__ORGII_SELECTED_ELEMENT_INFO__ = getElementInfo(source);
    }
    return true;
  } catch (e) {
    console.error("[Orgii Inspector] Failed to move element:", e);
    return false;
  }
};

// Mouse move handler
const handleMouseMove = (e) => {
  if (!inspectEnabled) return;

  // Handle drag in progress
  if (draggedElement) {
    const dx = e.clientX - dragStartX;
    const dy = e.clientY - dragStartY;

    // Check if we've exceeded drag threshold
    if (
      !isDragging &&
      (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD)
    ) {
      isDragging = true;
      document.body.style.cursor = "grabbing";
      // Hide hover highlight during drag
      highlightOverlay.style.display = "none";
      infoTooltip.style.display = "none";
    }

    // If dragging, show drop indicator
    if (isDragging) {
      const dropInfo = getDropPosition(e.clientX, e.clientY);
      showDropIndicator(dropInfo);
      return;
    }
  }

  // Normal hover behavior (when not dragging)
  const el = document.elementFromPoint(e.clientX, e.clientY);
  if (!el || isOverlayElement(el)) return;

  if (el !== hoveredElement) {
    hoveredElement = el;
    positionOverlay(highlightOverlay, el);

    const rect = el.getBoundingClientRect();
    const selector = getElementSelector(el);
    const dims = `${Math.round(rect.width)}px × ${Math.round(rect.height)}px`;
    const role = el.getAttribute("role") || el.tagName.toLowerCase();
    positionTooltip(el, `${selector}  ${dims}  Role: ${role}`);
  }
};

// Mouse down handler (start potential drag)
const handleMouseDown = (e) => {
  if (!inspectEnabled) return;

  suppressInspectEvent(e);

  const el = document.elementFromPoint(e.clientX, e.clientY);
  if (!el || isOverlayElement(el) || isUndraggable(el)) return;

  // Store drag start info
  draggedElement = el;
  dragStartX = e.clientX;
  dragStartY = e.clientY;
  isDragging = false;

  // Select the element immediately
  selectedElement = el;
  positionOverlay(selectedOverlay, el);
  window.__ORGII_SELECTED_ELEMENT_INFO__ = getElementInfo(el);
};

// Mouse up handler (end drag or complete click)
const handleMouseUp = (e) => {
  if (!inspectEnabled) return;

  suppressInspectEvent(e);

  if (isDragging && draggedElement) {
    // Complete the drag - move element
    const dropInfo = getDropPosition(e.clientX, e.clientY);
    if (dropInfo && dropInfo.target !== draggedElement) {
      moveElement(draggedElement, dropInfo.target, dropInfo.position);
    }
  }

  // Reset drag state
  isDragging = false;
  draggedElement = null;
  hideDropIndicator();
  document.body.style.cursor = "crosshair";
};

// Click handler (prevent default during inspect mode)
const handleClick = (e) => {
  suppressInspectEvent(e);
};

// Keyboard handler (Escape to cancel)
const handleKeyDown = (e) => {
  if (!inspectEnabled) return;

  if (e.key === "Escape") {
    suppressInspectEvent(e);

    // If dragging, cancel the drag instead of disabling inspect mode
    if (isDragging || draggedElement) {
      isDragging = false;
      draggedElement = null;
      hideDropIndicator();
      document.body.style.cursor = "crosshair";
      return;
    }
    window.__ORGII_DISABLE_INSPECT_MODE__();
  } else if (e.key === "Enter" || e.key === " ") {
    suppressInspectEvent(e);
  }
};

// Update overlay positions on scroll/resize
const updatePositions = () => {
  if (hoveredElement && inspectEnabled && !isDragging) {
    positionOverlay(highlightOverlay, hoveredElement);
    const rect = hoveredElement.getBoundingClientRect();
    const selector = getElementSelector(hoveredElement);
    const dims = `${Math.round(rect.width)}px × ${Math.round(rect.height)}px`;
    const role =
      hoveredElement.getAttribute("role") ||
      hoveredElement.tagName.toLowerCase();
    positionTooltip(hoveredElement, `${selector}  ${dims}  Role: ${role}`);
  }
  if (selectedElement) {
    positionOverlay(selectedOverlay, selectedElement);
  }
  // Cancel drag on scroll (avoids confusing behavior)
  if (isDragging) {
    isDragging = false;
    draggedElement = null;
    hideDropIndicator();
    document.body.style.cursor = "crosshair";
  }
};

window.addEventListener("scroll", updatePositions, true);
window.addEventListener("resize", updatePositions);
