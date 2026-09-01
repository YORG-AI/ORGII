/**
 * ResizeManager - Global Resize Coordination
 *
 * Provides global context for coordinating resize operations across the IDE.
 * Ensures only one resize can be active at a time and manages cursor/selection state.
 *
 * Usage:
 * ```tsx
 * // Wrap your app with ResizeProvider
 * <ResizeProvider>
 *   <App />
 * </ResizeProvider>
 *
 * // Use in components
 * const { isResizing, lock, unlock } = useResizeManager();
 * ```
 */
import React, {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";

import type { ResizeManagerContextType, ResizeSession } from "../types";

// ============================================
// Context
// ============================================

const ResizeManagerContext = createContext<ResizeManagerContextType>({
  isResizing: false,
  activeSession: null,
  lock: () => {},
  unlock: () => {},
  register: () => {},
  unregister: () => {},
});

// ============================================
// Provider
// ============================================

interface ResizeProviderProps {
  children: React.ReactNode;
}

export function ResizeProvider({ children }: ResizeProviderProps) {
  const [isResizing, setIsResizing] = useState(false);
  const [activeSession, setActiveSession] = useState<ResizeSession | null>(
    null
  );
  const registeredElements = useRef<Set<string>>(new Set());

  /**
   * Lock resize - called when a resize starts
   * Adds global CSS class and prevents other resizes
   */
  const lock = useCallback((session: ResizeSession) => {
    setIsResizing(true);
    setActiveSession(session);

    // Add global class for cursor and selection
    document.body.classList.add("resize-active");

    // Set cursor based on axis
    const cursor = session.axis === "x" ? "col-resize" : "row-resize";
    document.body.style.cursor = cursor;
    document.body.style.userSelect = "none";

    // Disable pointer events on iframes during resize
    document.querySelectorAll("iframe").forEach((iframe) => {
      iframe.style.pointerEvents = "none";
    });
  }, []);

  /**
   * Unlock resize - called when a resize ends
   * Removes global CSS class and allows new resizes
   */
  const unlock = useCallback(() => {
    setIsResizing(false);
    setActiveSession(null);

    // Remove global class
    document.body.classList.remove("resize-active");
    document.body.style.cursor = "";
    document.body.style.userSelect = "";

    // Re-enable pointer events on iframes
    document.querySelectorAll("iframe").forEach((iframe) => {
      iframe.style.pointerEvents = "";
    });
  }, []);

  /**
   * Register a resizable element
   */
  const register = useCallback((id: string) => {
    registeredElements.current.add(id);
  }, []);

  /**
   * Unregister a resizable element
   */
  const unregister = useCallback((id: string) => {
    registeredElements.current.delete(id);
  }, []);

  const value = useMemo<ResizeManagerContextType>(
    () => ({
      isResizing,
      activeSession,
      lock,
      unlock,
      register,
      unregister,
    }),
    [isResizing, activeSession, lock, unlock, register, unregister]
  );

  return (
    <ResizeManagerContext.Provider value={value}>
      {children}
    </ResizeManagerContext.Provider>
  );
}

// ============================================
// Hook
// ============================================

/**
 * Hook to access the resize manager context
 */
export function useResizeManager(): ResizeManagerContextType {
  const context = useContext(ResizeManagerContext);
  if (!context) {
    throw new Error("useResizeManager must be used within a ResizeProvider");
  }
  return context;
}
