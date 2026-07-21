/**
 * Pure parsing / resolution helpers shared by the Communication chat bubbles.
 *
 * Extracted verbatim from the original `ChatBubble.tsx`.
 */
import { PILL_REGEX, PILL_TYPES, type PillType } from "@src/config/pillTokens";
import type { ExtractedTodoData } from "@src/engines/SessionCore/rendering/types/universalProps";
import type { InstalledSkill } from "@src/types/extensions";

export interface TerminalPillData {
  displayName: string;
  terminalText: string;
}

export interface SkillPillData {
  displayName: string;
  /** Raw path token from the pill, e.g. "/create-skill" or "skill://create-skill" */
  rawPath: string;
  /** Resolved skill name (directory slug), derived from rawPath */
  skillName: string;
}

export type CommunicationTodoItem = ExtractedTodoData["todos"][number];

export const normalizeTodoStatus = (status: string): string =>
  (status || "").toLowerCase();

export const isTodoCompleted = (status: string): boolean => {
  const statusNorm = normalizeTodoStatus(status);
  return statusNorm.includes("completed") || statusNorm === "completed";
};

export const isTodoInProgress = (status: string): boolean =>
  normalizeTodoStatus(status) === "in_progress";

export function renderCommunicationTodoLabel(
  todo: CommunicationTodoItem
): string {
  if (
    isTodoInProgress(todo.status) &&
    todo.activeForm &&
    todo.activeForm.trim()
  ) {
    return todo.activeForm;
  }
  return todo.content;
}

export function hasOpenCommunicationTodoBlockers(
  todo: CommunicationTodoItem,
  allTodos: CommunicationTodoItem[]
): boolean {
  if (!todo.blockedBy || todo.blockedBy.length === 0) return false;
  return todo.blockedBy.some((blockerIndex) => {
    const blocker = allTodos.find(
      (todoItem, index) =>
        index === blockerIndex || Number(todoItem.id) === blockerIndex
    );
    if (!blocker) return false;
    const statusNorm = normalizeTodoStatus(blocker.status);
    return statusNorm !== "completed" && statusNorm !== "cancelled";
  });
}

export function communicationTodoRowKey(todoId: string, index: number): string {
  return `communication-todo:${todoId || "missing"}:${index}`;
}

export function extractCodeBlock(text: string): string | undefined {
  const match = text.match(/```\n?([\s\S]*?)```/);
  return match?.[1]?.trim() || undefined;
}

export function parseTerminalPills(content: string): TerminalPillData[] {
  const terminalPills: TerminalPillData[] = [];
  const codeBlockContent = extractCodeBlock(content);

  for (const match of content.matchAll(PILL_REGEX)) {
    const pillType = match[2] as PillType;
    if (pillType !== "terminal" || !PILL_TYPES.has(pillType)) continue;

    const displayName = match[1].trim();
    const rawPath = match[3];
    let terminalText: string | undefined;

    if (rawPath.includes("::")) {
      const encoded = rawPath.slice(rawPath.indexOf("::") + 2);
      try {
        terminalText = decodeURIComponent(atob(encoded));
      } catch {
        terminalText = undefined;
      }
    }
    if (!terminalText && codeBlockContent) {
      terminalText = codeBlockContent;
    }
    if (terminalText) {
      terminalPills.push({ displayName, terminalText });
    }
  }

  return terminalPills;
}

export function parseSkillPills(content: string): SkillPillData[] {
  const skillPills: SkillPillData[] = [];

  for (const match of content.matchAll(PILL_REGEX)) {
    const pillType = match[2] as PillType;
    if (pillType !== "skill" || !PILL_TYPES.has(pillType)) continue;

    const displayName = match[1].trim();
    const rawPath = match[3];
    // rawPath is like "/create-skill" or "skill://create-skill"
    const skillName = rawPath
      .replace(/^skill:\/\//, "")
      .replace(/^\//, "")
      .trim();
    if (skillName) {
      skillPills.push({ displayName, rawPath, skillName });
    }
  }

  return skillPills;
}

/**
 * Resolve a skill's actual file path from the installed skills list.
 * Falls back to constructing a likely path when not found.
 */
export function resolveSkillFilePath(
  skillName: string,
  installedSkills: InstalledSkill[]
): string | undefined {
  const lower = skillName.toLowerCase();
  const found = installedSkills.find((s) => {
    if (s.name.toLowerCase() === lower) return true;
    const normalized = s.path.replace(/\\/g, "/");
    const segments = normalized.split("/");
    const dirName = segments[segments.length - 2];
    return dirName?.toLowerCase() === lower;
  });
  return found?.path;
}
