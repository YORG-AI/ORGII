import { SLASH_ACTIONS, type SlashItem } from "@src/types/extensions";

interface BuildBuiltinSlashItemsOptions {
  canvasDescription: string;
  compactDescription: string;
  addressCommentsItem?: SlashItem | null;
  /**
   * Capability gate: the canvas command projects a `render_inline_canvas`
   * tool contract, which CLI agents don't have. Callers pass `false` for CLI
   * sessions so the menu never offers an action the projection would have to
   * no-op. Defaults to `true`.
   */
  includeCanvas?: boolean;
}

/** Shared built-in command registry for ChatPanel and Session Creator. */
export function buildBuiltinSlashItems({
  canvasDescription,
  compactDescription,
  addressCommentsItem,
  includeCanvas = true,
}: BuildBuiltinSlashItemsOptions): SlashItem[] {
  return [
    ...(includeCanvas
      ? [
          {
            name: SLASH_ACTIONS.CANVAS,
            description: canvasDescription,
            category: "action",
            source: "builtin",
            acceptsArgs: true,
          } satisfies SlashItem,
        ]
      : []),
    {
      name: SLASH_ACTIONS.COMPACT,
      description: compactDescription,
      category: "action",
      source: "builtin",
      acceptsArgs: true,
    },
    ...(addressCommentsItem ? [addressCommentsItem] : []),
  ];
}
