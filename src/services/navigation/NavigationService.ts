/**
 * NavigationService - Singleton Navigation Operations Service
 *
 * Provides code navigation capabilities shared by both AI and UI.
 * NOTE: Requires LSP integration for full functionality.
 *
 * Usage:
 *   import { NavigationService } from "@src/services/navigation";
 *   await NavigationService.goToDefinition();
 */

// ============================================
// Navigation History (simple implementation)
// ============================================

interface NavigationLocation {
  filePath: string;
  line: number;
  column: number;
}

const navigationHistory: NavigationLocation[] = [];
let historyIndex = -1;
const MAX_NAVIGATION_HISTORY = 100;

// ============================================
// NavigationService - Singleton API
// ============================================

export const NavigationService = {
  /**
   * Go to definition of symbol under cursor
   * TODO: Requires LSP integration
   */
  async goToDefinition(): Promise<boolean> {
    return false;
  },

  /**
   * Find all references of symbol under cursor
   * TODO: Requires LSP integration
   */
  async findReferences(): Promise<boolean> {
    return false;
  },

  /**
   * Go back to previous location
   */
  goBack(): boolean {
    if (historyIndex <= 0) {
      return false;
    }
    historyIndex--;
    return true;
  },

  /**
   * Go forward to next location
   */
  goForward(): boolean {
    if (historyIndex >= navigationHistory.length - 1) {
      return false;
    }
    historyIndex++;
    return true;
  },

  /**
   * Push a location to navigation history
   */
  pushLocation(location: NavigationLocation): void {
    // Remove any forward history
    navigationHistory.splice(historyIndex + 1);
    navigationHistory.push(location);
    if (navigationHistory.length > MAX_NAVIGATION_HISTORY) {
      const overflow = navigationHistory.length - MAX_NAVIGATION_HISTORY;
      navigationHistory.splice(0, overflow);
      historyIndex = Math.max(-1, historyIndex - overflow);
    }
    historyIndex = navigationHistory.length - 1;
  },

  /**
   * Clear navigation history
   */
  clearHistory(): void {
    navigationHistory.length = 0;
    historyIndex = -1;
  },

  /**
   * Get current history for debugging
   */
  getHistory(): { locations: NavigationLocation[]; index: number } {
    return {
      locations: [...navigationHistory],
      index: historyIndex,
    };
  },
};
