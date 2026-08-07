/**
 * sidebarConnectorUtils
 *
 * Constants and pure utility functions for WorkstationSidebarConnector.
 * Extracted to keep the main connector component under 600 lines.
 */
import type { SessionCreatorDraft } from "@src/store/session";

// ── Constants ─────────────────────────────────────────────────────────────────

/** Poll intervals for Cursor IDE session list refresh. */
export const CURSOR_IDE_ACTIVE_REFRESH_INTERVAL_MS = 60_000;
export const CURSOR_IDE_IDLE_REFRESH_INTERVAL_MS = 5 * 60_000;

// ORG2 channel sessions can be created from external surfaces (Feishu, etc.)
// without any frontend action. Refresh the full sidebar list while focused so
// `/newsession ...` appears in ORG2 without a manual page reload.
export const SIDEBAR_SESSION_ACTIVE_REFRESH_INTERVAL_MS = 15_000;
export const SIDEBAR_SESSION_IDLE_REFRESH_INTERVAL_MS = 60_000;

export const NEW_SESSION_MENU_ITEM_ID = "new-session";
export const PROJECTS_NEW_PROJECT_MENU_ITEM_ID = "projects-new-project";
export const PROJECTS_IMPORT_GITHUB_ISSUES_MENU_ITEM_ID =
  "projects-import-github-issues";
export const PROJECTS_NEW_WORK_ITEM_MENU_ITEM_ID = "projects-new-work-item";
export const WORK_ITEMS_MENU_ITEM_ID = "work-items";
export const KANBAN_MENU_ITEM_ID = "kanban";
export const WORK_ITEMS_PROJECTS_MENU_ITEM_ID = "work-items:projects";
export const WORK_ITEMS_GITHUB_ISSUES_MENU_ITEM_ID = "work-items:github-issues";
export const WORK_ITEMS_GITHUB_PRS_MENU_ITEM_ID = "work-items:github-prs";
export const COLLAB_ADD_ORG_MENU_ITEM_ID = "colleagues-add-org";
export const SESSION_CREATOR_DRAFT_MENU_PREFIX = "session-creator-draft:";

export function isWorkManagementMenuItemId(menuItemId: string): boolean {
  return (
    menuItemId === KANBAN_MENU_ITEM_ID ||
    menuItemId === WORK_ITEMS_MENU_ITEM_ID ||
    menuItemId.startsWith(`${WORK_ITEMS_MENU_ITEM_ID}:`)
  );
}

// ── Draft helpers ─────────────────────────────────────────────────────────────

export function getDraftMenuItemId(draftId: string): string {
  return `${SESSION_CREATOR_DRAFT_MENU_PREFIX}${draftId}`;
}

export function getDraftIdFromMenuItemId(menuItemId: string): string | null {
  if (!menuItemId.startsWith(SESSION_CREATOR_DRAFT_MENU_PREFIX)) return null;
  return menuItemId.slice(SESSION_CREATOR_DRAFT_MENU_PREFIX.length) || null;
}

export function isDraftMenuItemId(menuItemId: string): boolean {
  return getDraftIdFromMenuItemId(menuItemId) !== null;
}

export function getDraftPreviewText(draft: SessionCreatorDraft): string {
  if (draft.sessionName.trim()) return draft.sessionName.trim();
  const textContent = draft.editorContent
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (textContent) return textContent;
  return draft.uploadedFiles[0]?.name ?? "Draft";
}
