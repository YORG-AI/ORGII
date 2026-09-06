/**
 * File Content Types
 *
 * Types for file content operations.
 * Used by: editor hooks, repoApi.ts
 */

// ============================================
// File Content Types
// ============================================

/**
 * File content item from API
 */
export interface FileContentItem {
  content: string;
  encoding: string;
  info: {
    path: string;
    full_path: string;
    absolute_path: string;
    size: number;
    creation_time: string;
    modification_time: string;
    type: string;
  };
  type?: string;
  sessionId?: string;
}
