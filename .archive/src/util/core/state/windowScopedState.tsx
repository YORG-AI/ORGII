/**
 * Window-Scoped State Utilities
 *
 * Provides utilities for creating window-scoped Jotai atoms and localStorage
 * to enable true multi-window isolation.
 *
 * Each window gets its own state namespace to prevent state leaking between windows.
 *
 * Usage:
 * ```tsx
 * import { WindowStateProvider, useWindowId } from '@/src/util/windowScopedState';
 *
 * // In your root component
 * <WindowStateProvider>
 *   <App />
 * </WindowStateProvider>
 *
 * // In your components
 * const windowId = useWindowId(); // Get current window ID
 * ```
 */
import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import React, { createContext, useContext, useEffect, useMemo } from "react";

import { createLogger } from "@src/hooks/logger";

const log = createLogger("WindowScopedState");

// ============================================
// Window ID Management
// ============================================

/**
 * Generate a unique window ID
 * Format: window-{timestamp}-{random}
 */
export function generateWindowId(): string {
  return `window-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
}

/**
 * Get or create window ID from sessionStorage
 * sessionStorage is window-scoped, so each window gets its own ID
 *
 * Defensive: this runs at module-eval time via `windowIdAtom` (and
 * `getWindowScopedKey` in repo/atoms), which is inside the App's synchronous
 * import graph. Some WKWebView privacy states throw `SecurityError` on any
 * storage access — an unguarded throw here would abort first render and strand
 * the user on the splash. We fall back to a fresh in-memory id instead.
 */
let inMemoryWindowId: string | null = null;

export function getWindowId(): string {
  if (typeof window === "undefined") {
    return "window-ssr";
  }

  const key = "orgii-window-id";
  try {
    let windowId = sessionStorage.getItem(key);

    if (!windowId) {
      windowId = generateWindowId();
      sessionStorage.setItem(key, windowId);
    }

    return windowId;
  } catch {
    // sessionStorage unavailable/blocked — use a stable per-session fallback.
    if (!inMemoryWindowId) {
      inMemoryWindowId = generateWindowId();
    }
    return inMemoryWindowId;
  }
}

// ============================================
// Window-Scoped Storage
// ============================================

/**
 * Create a window-scoped localStorage key
 * Pattern: {baseKey}:{windowId}
 */
export function createWindowScopedKey(
  baseKey: string,
  windowId?: string
): string {
  const wId = windowId || getWindowId();
  return `${baseKey}:${wId}`;
}

/**
 * Window-scoped localStorage API
 * Automatically namespaces keys by window ID
 */
export class WindowScopedStorage {
  private windowId: string;

  constructor(windowId?: string) {
    this.windowId = windowId || getWindowId();
  }

  getItem(key: string): string | null {
    const scopedKey = createWindowScopedKey(key, this.windowId);
    return localStorage.getItem(scopedKey);
  }

  setItem(key: string, value: string): void {
    const scopedKey = createWindowScopedKey(key, this.windowId);
    localStorage.setItem(scopedKey, value);
  }

  removeItem(key: string): void {
    const scopedKey = createWindowScopedKey(key, this.windowId);
    localStorage.removeItem(scopedKey);
  }

  clear(): void {
    // Only clear items for this window
    const prefix = `:${this.windowId}`;
    const keysToRemove: string[] = [];

    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (key && key.endsWith(prefix)) {
        keysToRemove.push(key);
      }
    }

    keysToRemove.forEach((key) => localStorage.removeItem(key));
  }
}

// ============================================
// Window-Scoped Atoms
// ============================================

/**
 * Create a window-scoped atom with localStorage persistence
 * Similar to atomWithStorage but namespaced by window ID
 */
export function atomWithWindowScopedStorage<T>(
  baseKey: string,
  initialValue: T,
  windowId?: string
) {
  const wId = windowId || getWindowId();
  const scopedKey = createWindowScopedKey(baseKey, wId);

  return atomWithStorage<T>(scopedKey, initialValue);
}

/**
 * Window ID atom - provides current window ID to components
 */
export const windowIdAtom = atom<string>(getWindowId());

// ============================================
// Window State Provider Context
// ============================================

interface WindowStateContextValue {
  windowId: string;
  storage: WindowScopedStorage;
}

const WindowStateContext = createContext<WindowStateContextValue | null>(null);

/**
 * Provider for window-scoped state
 * Wraps your app to enable window-specific state isolation
 */
export const WindowStateProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const windowId = useMemo(() => getWindowId(), []);
  const storage = useMemo(() => new WindowScopedStorage(windowId), [windowId]);

  const contextValue = useMemo<WindowStateContextValue>(
    () => ({
      windowId,
      storage,
    }),
    [windowId, storage]
  );

  return (
    <WindowStateContext.Provider value={contextValue}>
      {children}
    </WindowStateContext.Provider>
  );
};

/**
 * Hook to access window-scoped state context
 */
export function useWindowStateContext(): WindowStateContextValue {
  const context = useContext(WindowStateContext);
  if (!context) {
    throw new Error(
      "useWindowStateContext must be used within WindowStateProvider"
    );
  }
  return context;
}

/**
 * Hook to get current window ID
 */
export function useWindowId(): string {
  const context = useContext(WindowStateContext);
  return context?.windowId || getWindowId();
}

/**
 * Hook to get window-scoped storage
 */
export function useWindowStorage(): WindowScopedStorage {
  const context = useContext(WindowStateContext);
  return context?.storage || new WindowScopedStorage();
}

// ============================================
// Window Registry (Track All Windows)
// ============================================

/**
 * Window registry tracks all active windows
 * Useful for managing global state across windows
 */
export interface WindowRegistryEntry {
  windowId: string;
  createdAt: number;
  lastActive: number;
  type?: string; // e.g., 'main', 'workspace', 'welcome'
}

class WindowRegistryClass {
  private static REGISTRY_KEY = "orgii-window-registry";

  /**
   * Register current window in the registry
   */
  register(type?: string): void {
    const windowId = getWindowId();
    const registry = this.getAll();

    registry[windowId] = {
      windowId,
      createdAt: Date.now(),
      lastActive: Date.now(),
      type,
    };

    this.save(registry);

    // Update last active periodically
    this.startHeartbeat();
  }

  /**
   * Unregister current window
   */
  unregister(): void {
    const windowId = getWindowId();
    const registry = this.getAll();
    delete registry[windowId];
    this.save(registry);
  }

  /**
   * Get all registered windows
   */
  getAll(): Record<string, WindowRegistryEntry> {
    try {
      const data = localStorage.getItem(WindowRegistryClass.REGISTRY_KEY);
      return data ? JSON.parse(data) : {};
    } catch {
      return {};
    }
  }

  /**
   * Get count of active windows
   */
  getCount(): number {
    return Object.keys(this.getAll()).length;
  }

  /**
   * Clean up stale windows (not active for > 1 hour)
   */
  cleanup(): void {
    const registry = this.getAll();
    const now = Date.now();
    const ONE_HOUR = 60 * 60 * 1000;

    let changed = false;
    for (const [windowId, entry] of Object.entries(registry)) {
      if (now - entry.lastActive > ONE_HOUR) {
        delete registry[windowId];
        changed = true;
      }
    }

    if (changed) {
      this.save(registry);
    }
  }

  private save(registry: Record<string, WindowRegistryEntry>): void {
    try {
      localStorage.setItem(
        WindowRegistryClass.REGISTRY_KEY,
        JSON.stringify(registry)
      );
    } catch (e) {
      log.error("Failed to save window registry:", e);
    }
  }

  private heartbeatStarted = false;
  private lastHeartbeatAt = 0;

  private touchCurrentWindow = (force = false): void => {
    if (document.visibilityState !== "visible") return;

    const now = Date.now();
    if (!force && now - this.lastHeartbeatAt < 30_000) return;

    const windowId = getWindowId();
    const registry = this.getAll();
    const entry = registry[windowId];
    if (!entry) return;

    entry.lastActive = now;
    this.lastHeartbeatAt = now;

    const ONE_HOUR = 60 * 60 * 1000;
    for (const [registeredWindowId, registeredEntry] of Object.entries(
      registry
    )) {
      if (now - registeredEntry.lastActive > ONE_HOUR) {
        delete registry[registeredWindowId];
      }
    }

    this.save(registry);
  };

  private handleVisibilityChange = (): void => {
    if (document.visibilityState === "visible") {
      this.touchCurrentWindow(true);
    }
  };

  private handleWindowActivity = (): void => {
    this.touchCurrentWindow();
  };

  private handleWindowFocus = (): void => {
    this.touchCurrentWindow(true);
  };

  private startHeartbeat(): void {
    if (this.heartbeatStarted) return;
    this.heartbeatStarted = true;
    this.lastHeartbeatAt = Date.now();
    window.addEventListener("focus", this.handleWindowFocus);
    window.addEventListener("pointerdown", this.handleWindowActivity);
    window.addEventListener("keydown", this.handleWindowActivity);
    document.addEventListener("visibilitychange", this.handleVisibilityChange);
  }

  /**
   * Stop heartbeat (call on window unload)
   */
  stopHeartbeat(): void {
    if (!this.heartbeatStarted) return;
    this.heartbeatStarted = false;
    window.removeEventListener("focus", this.handleWindowFocus);
    window.removeEventListener("pointerdown", this.handleWindowActivity);
    window.removeEventListener("keydown", this.handleWindowActivity);
    document.removeEventListener(
      "visibilitychange",
      this.handleVisibilityChange
    );
  }
}

export const WindowRegistry = new WindowRegistryClass();

// ============================================
// Auto-registration Hook
// ============================================

/**
 * Hook to auto-register window in registry
 * Call this at the root of your app
 */
export function useWindowRegistration(type?: string): void {
  useEffect(() => {
    WindowRegistry.register(type);

    // Unregister on unmount
    return () => {
      WindowRegistry.unregister();
      WindowRegistry.stopHeartbeat();
    };
  }, [type]);
}

// ============================================
// Utility Functions
// ============================================

/**
 * Check if running in multi-window mode
 */
export function isMultiWindow(): boolean {
  return WindowRegistry.getCount() > 1;
}

/**
 * Get window type from URL or other context
 */
export function getWindowType(): string {
  if (typeof window === "undefined") return "unknown";

  const path = window.location.pathname;

  if (path.includes("/orgii/workstation")) return "workspace";
  if (path === "/") return "main";

  return "unknown";
}
