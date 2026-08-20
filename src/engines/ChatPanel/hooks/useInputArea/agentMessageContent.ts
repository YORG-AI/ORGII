import { resolveCanvasSlashAgentContent } from "./canvasSlashCommand";

interface ResolveAgentMessageContentOptions {
  /** Serialized text retained in chat history. */
  displayText: string;
  /** Skill-expanded, base64-free text prepared for the Agent. */
  agentBase: string;
  hasTransformedPills: boolean;
  contextBlocks: string[];
  enableAgentInterceptors: boolean;
  /**
   * Capability gate for the Canvas interception. The projected contract
   * orders a `render_inline_canvas` call, which CLI agents don't have, and
   * an attached image means the user is sending real content that happens to
   * mention the command. Callers pass `false` in those cases so the message
   * goes through as ordinary text. Defaults to `true`.
   */
  allowCanvasInterception?: boolean;
}

/**
 * Produce the Agent-only message projection without mutating the history text.
 */
export function resolveAgentMessageContent({
  displayText,
  agentBase,
  hasTransformedPills,
  contextBlocks,
  enableAgentInterceptors,
  allowCanvasInterception = true,
}: ResolveAgentMessageContentOptions): string | undefined {
  // Canvas recognition runs on the DISPLAY text: the pill serialization is
  // recognized anywhere in the draft (the pill only exists because the user
  // picked the command) while typed `/canvas` prose stays start-anchored —
  // see parseCanvasSlashCommand. Running it on the expanded agent base would
  // silently drop mid-text pills (skill expansion collapses the pill and its
  // preceding prose into the bare token).
  const canvasContent =
    enableAgentInterceptors && allowCanvasInterception
      ? resolveCanvasSlashAgentContent(displayText)
      : null;
  const resolvedBase = canvasContent ?? agentBase;

  if (contextBlocks.length > 0) {
    return `${resolvedBase}\n\n${contextBlocks.join("\n\n")}`;
  }
  if (
    canvasContent !== null ||
    hasTransformedPills ||
    agentBase !== displayText
  ) {
    return resolvedBase;
  }
  return undefined;
}
