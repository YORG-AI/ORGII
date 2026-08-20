import {
  expandSkillPills,
  stripContextPillBase64,
} from "./outgoingTextTransforms";

interface CanvasSlashCommand {
  /** Optional creation request following `/canvas`. */
  instruction?: string;
}

/**
 * Parse a `/canvas [request]` command from the serialized DISPLAY text.
 *
 * Pill form ("canvas [skill:/canvas]", see serializePillNode) counts anywhere
 * in the draft — the pill only exists because the user picked the command, so
 * surrounding text on either side is the creation request. The plain typed
 * form stays start-anchored (mid-sentence "/canvas" is ordinary prose).
 * Mirrors `parseCompactSlashCommand`'s pill/typed split exactly.
 *
 * Module-private on purpose: external callers go through
 * `resolveCanvasSlashAgentContent` / `canvasSlashCommandNeedsInstruction`.
 */
function parseCanvasSlashCommand(text: string): CanvasSlashCommand | null {
  const trimmed = text.trim();

  const pillMatch = /canvas\s*\[skill:\/canvas\]/i.exec(trimmed);
  if (pillMatch) {
    const instruction = (
      trimmed.slice(0, pillMatch.index) +
      " " +
      trimmed.slice(pillMatch.index + pillMatch[0].length)
    ).trim();
    return instruction ? { instruction } : {};
  }

  const match = /^\/canvas(?:\s+([\s\S]+))?$/i.exec(trimmed);
  if (!match) return null;
  const instruction = match[1]?.trim();
  return instruction ? { instruction } : {};
}

/**
 * True while the draft is a Canvas creation command with no request text yet.
 * Drives the composer's argument ghost hint (mirrors the `/compact` hint).
 */
export function canvasSlashCommandNeedsInstruction(text: string): boolean {
  const command = parseCanvasSlashCommand(text);
  return command !== null && !command.instruction;
}

/**
 * Keep `/canvas …` as the user-visible message while giving the Agent an
 * explicit, deterministic Canvas tool contract.
 *
 * `text` is the serialized display text (pills intact) — the parser owns the
 * pill/typed recognition rules, and the extracted request is re-projected for
 * the Agent (skill pills expanded, editor-internal base64 payloads stripped)
 * before it enters the contract.
 */
export function resolveCanvasSlashAgentContent(text: string): string | null {
  const command = parseCanvasSlashCommand(text);
  if (!command) return null;

  if (!command.instruction) {
    return `[Canvas Creation Request]\nThe user opened the Canvas creation command without a request. Ask what they want to build before creating anything. Do not call render_inline_canvas yet.`;
  }

  const instruction = stripContextPillBase64(
    expandSkillPills(command.instruction).expanded
  );

  return `[Canvas Creation Request]\nCreate a new interactive inline Canvas for the user request below. Call render_inline_canvas exactly once for the finished Canvas. Treat this as a new Canvas rather than an edit to an existing Canvas. Preserve the user's requested behavior and language.\n\n[User Request]\n${instruction}`;
}
