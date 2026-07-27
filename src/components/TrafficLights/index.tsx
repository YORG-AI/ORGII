import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import React from "react";

import { createLogger } from "@src/hooks/logger";

const log = createLogger("TrafficLights");

// ============================================
// Type Definitions
// ============================================

export interface TrafficLightsProps {
  /**
   * Whether to disable the maximize button
   */
  disableMaximize?: boolean;

  /**
   * Custom handler function for closing the window
   */
  onClose?: () => Promise<void>;

  /**
   * Custom handler function for minimizing the window
   */
  onMinimize?: () => Promise<void>;

  /**
   * Custom handler function for maximizing/restoring the window
   */
  onMaximize?: () => Promise<void>;

  /**
   * Additional class name
   */
  className?: string;
}

// ============================================
// Component Implementation
// ============================================

/**
 * TrafficLights Component
 *
 * macOS-style traffic light window control button component
 * Provides window control buttons (close, minimize, maximize) for macOS-style windows
 */
const TrafficLights: React.FC<TrafficLightsProps> = ({
  disableMaximize = false,
  onClose,
  onMinimize,
  onMaximize,
  className = "",
}) => {
  // Close window
  const handleClose = async () => {
    if (onClose) {
      await onClose();
      return;
    }

    try {
      const currentWindow = WebviewWindow.getCurrent();
      await currentWindow.close();
    } catch (error) {
      log.error("Error closing window:", error);
    }
  };

  // Minimize window
  const handleMinimize = async () => {
    if (onMinimize) {
      await onMinimize();
      return;
    }

    try {
      const currentWindow = WebviewWindow.getCurrent();
      await currentWindow.minimize();
    } catch (error) {
      log.error("Error minimizing window:", error);
    }
  };

  // Maximize/restore window
  const handleMaximize = async () => {
    if (onMaximize) {
      await onMaximize();
      return;
    }

    try {
      const currentWindow = WebviewWindow.getCurrent();
      const isMaximized = await currentWindow.isMaximized();

      if (isMaximized) {
        await currentWindow.unmaximize();
      } else {
        await currentWindow.maximize();
      }
    } catch (error) {
      log.error("Error maximizing/restoring window:", error);
    }
  };

  const handleKeyActivate = (
    event: React.KeyboardEvent<HTMLDivElement>,
    action: () => void
  ) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      action();
    }
  };

  return (
    <div className={`title-bar-buttons flex items-center ${className}`}>
      {/* Red button - Close */}
      <div
        className="mr-1.5 h-[14px] w-[14px] cursor-pointer rounded-full border-[0.5px] border-solid border-[#CE5347] bg-[#ED6A5E]"
        role="button"
        tabIndex={0}
        aria-label="Close window"
        onClick={handleClose}
        onKeyDown={(event) => handleKeyActivate(event, handleClose)}
      ></div>

      {/* Yellow button - Minimize */}
      <div
        className="mr-1.5 h-[14px] w-[14px] cursor-pointer rounded-full border-[0.5px] border-solid border-[#D6A243] bg-[#F6BE4F]"
        role="button"
        tabIndex={0}
        aria-label="Minimize window"
        onClick={handleMinimize}
        onKeyDown={(event) => handleKeyActivate(event, handleMinimize)}
      ></div>

      {/* Green button - Maximize/restore, can be disabled */}
      <div
        className={`h-[14px] w-[14px] rounded-full border-[0.5px] border-solid border-[#58A942] bg-[#62C554] ${
          disableMaximize ? "cursor-not-allowed opacity-50" : "cursor-pointer"
        }`}
        role="button"
        tabIndex={disableMaximize ? -1 : 0}
        aria-label="Maximize or restore window"
        aria-disabled={disableMaximize}
        onClick={disableMaximize ? undefined : handleMaximize}
        onKeyDown={
          disableMaximize
            ? undefined
            : (event) => handleKeyActivate(event, handleMaximize)
        }
      ></div>
    </div>
  );
};

export default TrafficLights;
