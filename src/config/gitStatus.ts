/**
 * Git Status Configuration - Single Source of Truth
 *
 * Centralized git status styling following VSCode conventions.
 * All components should import from this file to ensure consistency.
 *
 * Git Status Color Convention (matches Cursor):
 * - M = Modified (warm amber)
 * - U = Untracked (green)
 * - D = Deleted (red)
 * - R = Renamed (blue)
 * - C = Conflict (red)
 *
 * THEME SUPPORT:
 * To add theme support, override the color maps in this file.
 * All components using this config will automatically update.
 */

// ============================================
// Types
// ============================================

/**
 * Git file status as returned by backend API
 */
export type GitApiStatus =
  | "M"
  | "A"
  | "D"
  | "R"
  | "C"
  | "U"
  | "?"
  | "!"
  | string;

/**
 * Normalized git file status used in frontend
 */
export type GitFileStatus =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "conflict"
  | "ignored";

/**
 * Display status letter (VSCode style)
 * I = Ignored (dimmed, low opacity)
 */
export type GitStatusLetter = "M" | "U" | "A" | "D" | "R" | "C" | "I" | "?";

// ============================================
// Status Letter Mapping (API → Display)
// ============================================

/**
 * Map API status codes to display letters (VSCode convention)
 *
 * Note: Both "A" (added/staged) and "?" (untracked) map to "U" (Untracked)
 * This matches VSCode's convention of showing all new files as "U"
 */
export function getStatusLetter(
  status: GitApiStatus | GitFileStatus
): GitStatusLetter {
  // Handle API status codes (single letters)
  if (status.length === 1) {
    switch (status) {
      case "M":
        return "M"; // Modified
      case "A":
      case "?":
        return "U"; // Untracked (both staged new files and untracked files)
      case "D":
        return "D"; // Deleted
      case "R":
        return "R"; // Renamed
      case "C":
      case "U": // API "U" means Unmerged/Conflict
        return "C"; // Conflict
      case "!":
        return "I"; // Ignored
      default:
        return "?"; // Unknown
    }
  }

  // Handle normalized status (full words)
  switch (status) {
    case "modified":
      return "M";
    case "added":
      return "U"; // VSCode convention: show as Untracked
    case "deleted":
      return "D";
    case "renamed":
      return "R";
    case "conflict":
      return "C";
    case "ignored":
      return "I";
    default:
      return "?";
  }
}

// ============================================
// Status Colors (Tailwind Classes)
// ============================================

/**
 * Color map for git status text colors (VSCode theme)
 *
 * THEME OVERRIDE: To add theme support, replace this map with dynamic values
 * based on current theme. All components will automatically use the new colors.
 */
const STATUS_TEXT_COLOR_MAP: Record<GitStatusLetter, string> = {
  M: "text-warning-6", // Modified — warm amber
  U: "text-success-6", // Untracked — green
  A: "text-success-6", // Added (staged) — green
  D: "text-danger-6", // Deleted — red
  R: "text-primary-6", // Renamed — blue, distinct from added
  C: "text-danger-6", // Conflict — red
  I: "text-text-3", // Ignored
  "?": "text-text-3", // Unknown
};

/**
 * Get Tailwind text color class for status letter (VSCode colors)
 *
 * Uses centralized color map for easy theme customization.
 *
 * IMPORTANT: This function accepts both API status codes and display letters.
 * If the input is already a valid display letter (M, U, A, D, R, C, ?),
 * it uses it directly. Otherwise, it converts via getStatusLetter.
 */
export function getStatusColor(
  status: GitStatusLetter | GitApiStatus | GitFileStatus
): string {
  // If input is a single character, check if it's already a valid display letter
  if (typeof status === "string" && status.length === 1) {
    // Direct lookup first - handles display letters (M, U, A, D, R, C, ?)
    const directColor = STATUS_TEXT_COLOR_MAP[status as GitStatusLetter];
    if (directColor) {
      return directColor;
    }
    // Not a display letter, treat as API status and convert
    return (
      STATUS_TEXT_COLOR_MAP[getStatusLetter(status as GitApiStatus)] ||
      "text-text-2"
    );
  }

  // For normalized status strings (modified, added, etc.), convert to letter
  const letter = getStatusLetter(status as GitFileStatus);
  return STATUS_TEXT_COLOR_MAP[letter] || "text-text-2";
}

/**
 * Color map for git status background colors (for dots, badges, etc.)
 *
 * THEME OVERRIDE: To add theme support, replace this map with dynamic values
 * based on current theme. All components will automatically use the new colors.
 */
const STATUS_BG_COLOR_MAP: Record<GitStatusLetter, string> = {
  M: "bg-warning-5", // Modified — warm amber dot
  U: "bg-success-5", // Untracked — green dot
  A: "bg-success-5", // Added (staged) — green dot
  D: "bg-danger-5", // Deleted — red dot
  R: "bg-primary-5", // Renamed — blue dot, distinct from added
  C: "bg-danger-5", // Conflict — red dot
  I: "bg-text-3", // Ignored
  "?": "bg-text-3", // Unknown
};

/**
 * Get Tailwind background color class for status (for folder dots, badges, etc.)
 *
 * Uses centralized color map for easy theme customization.
 *
 * IMPORTANT: This function accepts both API status codes and display letters.
 * If the input is already a valid display letter (M, U, A, D, R, C, ?),
 * it uses it directly. Otherwise, it converts via getStatusLetter.
 */
export function getStatusBgColor(
  status: GitStatusLetter | GitApiStatus | GitFileStatus
): string {
  // If input is a single character, check if it's already a valid display letter
  if (typeof status === "string" && status.length === 1) {
    // Direct lookup first - handles display letters (M, U, A, D, R, C, ?)
    const directColor = STATUS_BG_COLOR_MAP[status as GitStatusLetter];
    if (directColor) {
      return directColor;
    }
    // Not a display letter, treat as API status and convert
    return (
      STATUS_BG_COLOR_MAP[getStatusLetter(status as GitApiStatus)] ||
      "bg-text-3"
    );
  }

  // For normalized status strings (modified, added, etc.), convert to letter
  const letter = getStatusLetter(status as GitFileStatus);

  return STATUS_BG_COLOR_MAP[letter] || "bg-text-3";
}

// ============================================
// Status Label Helpers
// ============================================

/**
 * Get full status name for display
 */
export function getStatusLabel(
  status: GitStatusLetter | GitApiStatus | GitFileStatus
): string {
  const letter =
    typeof status === "string" && status.length === 1
      ? getStatusLetter(status as GitApiStatus)
      : getStatusLetter(status as GitFileStatus);

  switch (letter) {
    case "M":
      return "Modified";
    case "U":
      return "Untracked";
    case "A":
      return "Added";
    case "D":
      return "Deleted";
    case "R":
      return "Renamed";
    case "C":
      return "Conflict";
    case "I":
      return "Ignored";
    case "?":
      return "Unknown";
    default:
      return "Unknown";
  }
}

// ============================================
// API Normalization
// ============================================

/**
 * Map API status to normalized frontend status
 * Used when converting API responses to frontend types
 */
export function normalizeGitStatus(status: GitApiStatus): GitFileStatus {
  switch (status) {
    case "M":
      return "modified";
    case "A":
    case "?":
      return "added"; // Frontend uses "added" for all new files
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "C":
    case "U":
      return "conflict";
    case "!":
      return "ignored";
    default:
      return "modified"; // Fallback
  }
}

// ============================================
// Combined Helpers
// ============================================

/**
 * Get complete status info (letter + color) in one call
 */
export function getStatusInfo(status: GitApiStatus | GitFileStatus): {
  letter: GitStatusLetter;
  textColor: string;
  bgColor: string;
  label: string;
} {
  const letter = getStatusLetter(status);
  return {
    letter,
    textColor: getStatusColor(letter),
    bgColor: getStatusBgColor(letter),
    label: getStatusLabel(letter),
  };
}

/**
 * Get status letter for files, handling staged/unstaged distinction
 *
 * VSCode Convention:
 * - Staged new files show "A" (Added)
 * - Unstaged new files show "U" (Untracked)
 *
 * @param status - Git file status
 * @param staged - Whether the file is staged
 * @returns Display letter (A for staged added, U for unstaged added, etc.)
 */
export function getStatusLetterForFile(
  status: GitApiStatus | GitFileStatus,
  staged: boolean
): GitStatusLetter {
  // Special handling: staged "added" files show "A", unstaged show "U"
  if ((status === "added" || status === "A" || status === "?") && staged) {
    return "A";
  }
  // For all other cases, use the standard letter mapping
  return getStatusLetter(status);
}

/**
 * Get status color for files, handling staged/unstaged distinction
 *
 * @param status - Git file status
 * @param staged - Whether the file is staged
 * @returns Tailwind text color class
 */
export function getStatusColorForFile(
  status: GitApiStatus | GitFileStatus,
  staged: boolean
): string {
  const letter = getStatusLetterForFile(status, staged);
  return STATUS_TEXT_COLOR_MAP[letter] || "text-text-2";
}

// ============================================
// Theme Customization (Future Enhancement)
// ============================================

/**
 * FUTURE: Theme override function
 *
 * Example usage when theme system is implemented:
 *
 * ```typescript
 * setGitStatusTheme({
 *   textColors: {
 *     M: "text-custom-modified",
 *     U: "text-custom-untracked",
 *     // ... etc
 *   },
 *   bgColors: {
 *     M: "bg-custom-modified",
 *     U: "bg-custom-untracked",
 *     // ... etc
 *   }
 * });
 * ```
 *
 * This would update STATUS_TEXT_COLOR_MAP and STATUS_BG_COLOR_MAP,
 * and all components would automatically use the new theme colors.
 */
export interface GitStatusTheme {
  textColors?: Partial<Record<GitStatusLetter, string>>;
  bgColors?: Partial<Record<GitStatusLetter, string>>;
}
