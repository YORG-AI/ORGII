// Element Inspector - Inspect Mode Control
// Provides enable/disable/toggle functionality for the inspector

const inspectBlockedEventNames = [
  "dblclick",
  "auxclick",
  "contextmenu",
  "dragstart",
  "submit",
];

const handleBlockedInspectEvent = (e) => {
  suppressInspectEvent(e);
};

const addInspectListener = (eventName, handler) => {
  window.addEventListener(eventName, handler, INSPECT_EVENT_OPTIONS);
};

const removeInspectListener = (eventName, handler) => {
  window.removeEventListener(eventName, handler, INSPECT_EVENT_OPTIONS);
};

// Enable inspect mode
window.__ORGII_ENABLE_INSPECT_MODE__ = function () {
  if (inspectEnabled) return;
  inspectEnabled = true;
  document.body.style.cursor = "crosshair";
  addInspectListener("mousemove", handleMouseMove);
  addInspectListener("mousedown", handleMouseDown);
  addInspectListener("mouseup", handleMouseUp);
  addInspectListener("click", handleClick);
  addInspectListener("keydown", handleKeyDown);
  inspectBlockedEventNames.forEach((eventName) => {
    addInspectListener(eventName, handleBlockedInspectEvent);
  });
};

// Disable inspect mode
window.__ORGII_DISABLE_INSPECT_MODE__ = function () {
  if (!inspectEnabled) return;
  inspectEnabled = false;
  document.body.style.cursor = "";
  removeInspectListener("mousemove", handleMouseMove);
  removeInspectListener("mousedown", handleMouseDown);
  removeInspectListener("mouseup", handleMouseUp);
  removeInspectListener("click", handleClick);
  removeInspectListener("keydown", handleKeyDown);
  inspectBlockedEventNames.forEach((eventName) => {
    removeInspectListener(eventName, handleBlockedInspectEvent);
  });
  highlightOverlay.style.display = "none";
  infoTooltip.style.display = "none";
  hideDropIndicator();
  hoveredElement = null;
  isDragging = false;
  draggedElement = null;
};

// Toggle inspect mode
window.__ORGII_TOGGLE_INSPECT_MODE__ = function () {
  if (inspectEnabled) {
    window.__ORGII_DISABLE_INSPECT_MODE__();
    return false;
  } else {
    window.__ORGII_ENABLE_INSPECT_MODE__();
    return true;
  }
};

// Get inspect mode state
window.__ORGII_IS_INSPECT_MODE_ENABLED__ = function () {
  return inspectEnabled;
};
