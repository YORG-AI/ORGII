/**
 * ShortcutRegistry - Unified Keyboard Shortcut Management
 *
 * Runtime registry for the current global shortcut subset.
 *
 * Architecture note:
 * - Display metadata lives in src/config/keyboard/shortcuts/*
 * - useGlobalShortcuts currently dispatches many shortcuts manually
 * - Native app menu accelerators are managed by Rust in system-services/src/app_menu.rs
 */

// ============================================
// Type Definitions
// ============================================

export type Modifier = "cmd" | "ctrl" | "alt" | "shift";

export type ShortcutCategory =
  | "navigation" // Tab switching, spotlight, etc.
  | "window" // Window management (close, minimize, new window)
  | "editing" // Text editing
  | "view" // Zoom, display settings
  | "debugging" // Inspect mode, component issue
  | "panels"; // Chat panel, API panel

export type ShortcutScope =
  | "global" // Works everywhere
  | "spotlight" // Only in spotlight/selectors
  | "editor" // Only in code editor
  | "workstation" // Only on Workstation page
  | "input"; // Only when focused on input

export interface ShortcutDefinition {
  /** Unique identifier for the shortcut */
  id: string;

  /** Human-readable description */
  description: string;

  /** The key to match (e.g., "=", "-", "w", "Tab") */
  key: string;

  /** Alternative keys that also trigger this shortcut (e.g., ["+"] for zoom in) */
  altKeys?: string[];

  /** Required modifiers */
  modifiers: Modifier[];

  /** Tauri accelerator format (auto-generated if not provided) */
  accelerator?: string;

  /** Category for grouping */
  category: ShortcutCategory;

  /** Where the shortcut is active */
  scope: ShortcutScope;

  /** Include in OS menu bar? */
  showInMenu?: boolean;

  /** Override menu text (defaults to description) */
  menuLabel?: string;

  /** Menu section for grouping (e.g., "File", "View", "Window") */
  menuSection?: "File" | "Edit" | "View" | "Window" | "Help";

  /** Whether the shortcut can be customized by users (future) */
  customizable?: boolean;

  /** Condition function - if provided, shortcut only fires when this returns true */
  condition?: () => boolean;
}

// ============================================
// Shortcut Definitions
// ============================================

/**
 * All global shortcuts defined in one place.
 * This is the SINGLE SOURCE OF TRUTH for keyboard shortcuts.
 */
export const SHORTCUT_DEFINITIONS: ShortcutDefinition[] = [
  // ============================================
  // View
  // ============================================
  {
    id: "zoom_in",
    description: "Zoom in",
    key: "=",
    altKeys: ["+"],
    modifiers: ["cmd"],
    accelerator: "CmdOrCtrl+Plus",
    category: "view",
    scope: "global",
    showInMenu: true,
    menuLabel: "Zoom in",
    menuSection: "View",
  },
  {
    id: "zoom_out",
    description: "Zoom out",
    key: "-",
    modifiers: ["cmd"],
    accelerator: "CmdOrCtrl+Minus",
    category: "view",
    scope: "global",
    showInMenu: true,
    menuLabel: "Zoom out",
    menuSection: "View",
  },
  {
    id: "zoom_reset",
    description: "Reset zoom",
    key: "0",
    modifiers: ["cmd"],
    accelerator: "CmdOrCtrl+0",
    category: "view",
    scope: "global",
    showInMenu: true,
    menuLabel: "Reset zoom",
    menuSection: "View",
  },
  {
    id: "route_debug_modal",
    description: "Show current route information",
    key: "0",
    modifiers: ["cmd", "shift"],
    category: "debugging",
    scope: "global",
    showInMenu: false,
  },

  // ============================================
  // Window Management
  // ============================================
  {
    id: "quit_app",
    description: "Hold to quit application",
    key: "q",
    modifiers: ["cmd"],
    accelerator: "CmdOrCtrl+Q",
    category: "window",
    scope: "global",
    showInMenu: true,
    menuLabel: "Quit",
    menuSection: "File",
  },
  {
    id: "close_tab",
    description: "Close current tab",
    key: "w",
    modifiers: ["cmd"],
    accelerator: "CmdOrCtrl+W",
    category: "window",
    scope: "global",
    showInMenu: true,
    menuLabel: "Close tab",
    menuSection: "Window",
  },
  {
    id: "hide_window",
    description: "Minimize window",
    key: "m",
    modifiers: ["cmd"],
    accelerator: "CmdOrCtrl+M",
    category: "window",
    scope: "global",
    showInMenu: true,
    menuLabel: "Minimize",
    menuSection: "Window",
  },
  {
    id: "maximize_work_station",
    description: "Maximize Workstation",
    key: "m",
    modifiers: ["cmd", "shift"],
    accelerator: "CmdOrCtrl+Shift+M",
    category: "window",
    scope: "workstation",
    showInMenu: false,
  },
  {
    id: "toggle_ade_manager",
    description: "Open ADE Manager",
    key: "g",
    modifiers: ["cmd", "alt"],
    accelerator: "CmdOrCtrl+Alt+G",
    category: "view",
    scope: "global",
    showInMenu: false,
  },
  {
    id: "new_session",
    description: "Create new session",
    key: "n",
    modifiers: ["cmd"],
    accelerator: "CmdOrCtrl+N",
    category: "navigation",
    scope: "global",
    showInMenu: false,
  },

  // ============================================
  // Navigation
  // ============================================
  {
    id: "new_tab",
    description: "New tab",
    key: "t",
    modifiers: ["cmd"],
    accelerator: "CmdOrCtrl+T",
    category: "navigation",
    scope: "global",
    showInMenu: false,
  },
  {
    id: "new_tab_alt",
    description: "New tab (alternative)",
    key: "l",
    modifiers: ["cmd"],
    accelerator: "CmdOrCtrl+L",
    category: "navigation",
    scope: "global",
    showInMenu: false,
  },
  {
    id: "toggle_spotlight",
    description: "Toggle spotlight",
    key: "p",
    modifiers: ["cmd", "shift"],
    accelerator: "CmdOrCtrl+Shift+P",
    category: "navigation",
    scope: "global",
    showInMenu: false,
  },

  // ============================================
  // Panels
  // ============================================
  {
    id: "toggle_api_panel",
    description: "Toggle API panel",
    key: "5",
    modifiers: ["cmd"],
    accelerator: "CmdOrCtrl+5",
    category: "panels",
    scope: "global",
    showInMenu: false,
  },
  {
    id: "maximize_chat",
    description: "Focus Chat Panel / Show Workstation",
    key: "b",
    modifiers: ["cmd", "alt"],
    accelerator: "CmdOrCtrl+Alt+B",
    category: "panels",
    scope: "workstation",
    showInMenu: false,
  },

  // ============================================
  // Debugging
  // ============================================
  {
    id: "toggle_inspect_mode",
    description: "Toggle inspect mode",
    key: "8",
    modifiers: ["cmd"],
    accelerator: "CmdOrCtrl+8",
    category: "debugging",
    scope: "global",
    showInMenu: false,
  },
  {
    id: "capture_component",
    description: "Capture component issue",
    key: "9",
    modifiers: ["cmd"],
    accelerator: "CmdOrCtrl+9",
    category: "debugging",
    scope: "global",
    showInMenu: false,
  },
  // ============================================
  // Tab Navigation
  // ============================================
  {
    id: "next_tab",
    description: "Next tab",
    key: "Tab",
    modifiers: ["ctrl"],
    category: "navigation",
    scope: "global",
    showInMenu: false,
  },
  {
    id: "previous_tab",
    description: "Previous tab",
    key: "Tab",
    modifiers: ["ctrl", "shift"],
    category: "navigation",
    scope: "global",
    showInMenu: false,
  },
  {
    id: "next_tab_mac",
    description: "Next tab (macOS)",
    key: "ArrowRight",
    modifiers: ["cmd", "alt"],
    category: "navigation",
    scope: "global",
    showInMenu: false,
  },
  {
    id: "previous_tab_mac",
    description: "Previous tab (macOS)",
    key: "ArrowLeft",
    modifiers: ["cmd", "alt"],
    category: "navigation",
    scope: "global",
    showInMenu: false,
  },
];

// ============================================
// ShortcutRegistry Class
// ============================================

class ShortcutRegistryClass {
  private shortcuts: Map<string, ShortcutDefinition> = new Map();
  private isMac: boolean;

  constructor() {
    this.isMac =
      typeof navigator !== "undefined" &&
      navigator.platform.toUpperCase().indexOf("MAC") >= 0;

    // Initialize from definitions
    for (const def of SHORTCUT_DEFINITIONS) {
      this.shortcuts.set(def.id, def);
    }
  }

  // ============================================
  // Query Methods
  // ============================================

  /**
   * Get a shortcut definition by ID
   */
  get(id: string): ShortcutDefinition | undefined {
    return this.shortcuts.get(id);
  }

  /**
   * Get all shortcuts that should appear in OS menus
   */
  getMenuShortcuts(): ShortcutDefinition[] {
    return Array.from(this.shortcuts.values()).filter(
      (shortcut) => shortcut.showInMenu
    );
  }

  /**
   * Get shortcuts for a specific menu section
   */
  getMenuSection(
    section: ShortcutDefinition["menuSection"]
  ): ShortcutDefinition[] {
    return this.getMenuShortcuts().filter(
      (shortcut) => shortcut.menuSection === section
    );
  }

  /**
   * Get all shortcuts by category
   */
  getByCategory(category: ShortcutCategory): ShortcutDefinition[] {
    return Array.from(this.shortcuts.values()).filter(
      (shortcut) => shortcut.category === category
    );
  }

  /**
   * Get the Tauri accelerator string for a shortcut
   */
  getAccelerator(id: string): string | undefined {
    return this.shortcuts.get(id)?.accelerator;
  }

  // ============================================
  // Event Matching
  // ============================================

  /**
   * Check if a keyboard event matches any registered shortcut
   * Returns the matched shortcut or null
   */
  matchEvent(event: KeyboardEvent): ShortcutDefinition | null {
    // Skip during IME composition
    if (event.isComposing) {
      return null;
    }

    const eventKey = event.key.toLowerCase();

    for (const shortcut of this.shortcuts.values()) {
      if (this.doesEventMatch(event, eventKey, shortcut)) {
        // Check condition if provided
        if (shortcut.condition && !shortcut.condition()) {
          continue;
        }
        return shortcut;
      }
    }

    return null;
  }

  /**
   * Check if an event matches a specific shortcut definition
   */
  private doesEventMatch(
    event: KeyboardEvent,
    eventKey: string,
    shortcut: ShortcutDefinition
  ): boolean {
    // Check key match (primary or alt keys)
    const keyMatches =
      eventKey === shortcut.key.toLowerCase() ||
      shortcut.altKeys?.some((altKey) => eventKey === altKey.toLowerCase());

    if (!keyMatches) {
      return false;
    }

    // Check modifiers
    const requiresCmd = shortcut.modifiers.includes("cmd");
    const requiresCtrl = shortcut.modifiers.includes("ctrl");
    const requiresAlt = shortcut.modifiers.includes("alt");
    const requiresShift = shortcut.modifiers.includes("shift");

    // On Mac, "cmd" means metaKey; on other platforms, "cmd" means ctrlKey
    const cmdPressed = this.isMac ? event.metaKey : event.ctrlKey;
    const ctrlPressed = event.ctrlKey;
    const altPressed = event.altKey;
    const shiftPressed = event.shiftKey;

    // Check cmd/ctrl modifier
    if (requiresCmd && !cmdPressed) return false;
    if (requiresCtrl && !ctrlPressed) return false;
    if (requiresAlt && !altPressed) return false;
    if (requiresShift && !shiftPressed) return false;

    // Check that we don't have extra modifiers pressed
    // (unless the shortcut requires cmd, which may overlap with ctrl on non-Mac)
    if (!requiresCmd && !requiresCtrl && (event.metaKey || event.ctrlKey)) {
      // Has modifier but shortcut doesn't require it
      if (requiresAlt || requiresShift) {
        // But does require alt/shift, so the cmd/ctrl is extra
        return false;
      }
    }

    return true;
  }

  // ============================================
  // Event Dispatching
  // ============================================

  /**
   * Dispatch a shortcut event by ID
   * This fires a custom event that handlers can listen to
   */
  dispatch(id: string): void {
    window.dispatchEvent(new CustomEvent(`shortcut:${id}`));
  }

  /**
   * Register a handler for a shortcut event
   * Returns an unsubscribe function
   */
  on(id: string, handler: () => void): () => void {
    const eventName = `shortcut:${id}`;
    window.addEventListener(eventName, handler);
    return () => window.removeEventListener(eventName, handler);
  }

  // ============================================
  // Display Helpers
  // ============================================

  /**
   * Get a display string for a shortcut (e.g., "⌘=" or "Ctrl+=")
   */
  getDisplayString(id: string): string {
    const shortcut = this.shortcuts.get(id);
    if (!shortcut) return "";

    const parts: string[] = [];

    for (const mod of shortcut.modifiers) {
      if (mod === "cmd") {
        parts.push(this.isMac ? "⌘" : "Ctrl");
      } else if (mod === "ctrl") {
        parts.push("Ctrl");
      } else if (mod === "alt") {
        parts.push(this.isMac ? "⌥" : "Alt");
      } else if (mod === "shift") {
        parts.push(this.isMac ? "⇧" : "Shift");
      }
    }

    // Format key for display
    let keyDisplay = shortcut.key;
    if (keyDisplay === "ArrowRight") keyDisplay = "→";
    else if (keyDisplay === "ArrowLeft") keyDisplay = "←";
    else if (keyDisplay === "ArrowUp") keyDisplay = "↑";
    else if (keyDisplay === "ArrowDown") keyDisplay = "↓";
    else keyDisplay = keyDisplay.toUpperCase();

    parts.push(keyDisplay);

    return this.isMac ? parts.join("") : parts.join("+");
  }

  /**
   * Get all shortcuts for display (e.g., in a help modal)
   */
  getAllForDisplay(): Array<{
    id: string;
    description: string;
    keys: string;
    category: ShortcutCategory;
  }> {
    return Array.from(this.shortcuts.values()).map((shortcut) => ({
      id: shortcut.id,
      description: shortcut.description,
      keys: this.getDisplayString(shortcut.id),
      category: shortcut.category,
    }));
  }
}

// ============================================
// Singleton Export
// ============================================

export const shortcutRegistry = new ShortcutRegistryClass();

// Export types for consumers
export type { ShortcutRegistryClass };
