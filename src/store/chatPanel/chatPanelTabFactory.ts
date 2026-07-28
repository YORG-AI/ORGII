/**
 * Chat Panel Tab Factory
 *
 * A small factory helper — mirroring `src/store/workstation/tabs/tabFactory.ts`
 * — that centralizes construction of `ChatPanelTab` objects so every open path
 * produces a consistent shape (id / type / title / timestamps / typed payload)
 * instead of hand-rolling the literal at each call site.
 *
 * ## ID strategies
 * 1. **fixed**  — a constant id (e.g. "chat-runtime"); the tab is a
 *                 singleton and openers dedupe by searching `tab.type`.
 * 2. **uuid**   — `"<prefix>-<uuid>"`; a fresh instance every time.
 * 3. **keyed**  — `"<prefix>:<key>"`; deterministic from the payload so the
 *                 same entity re-uses the same id.
 *
 * Concrete factories live in `chatPanelTabFactories.ts`.
 */
import type { ChatPanelTab, ChatPanelTabType } from "./chatPanelTabsModel";

/** Type-specific fields a factory stamps onto the tab. */
export type ChatPanelTabPayload = Omit<
  Partial<ChatPanelTab>,
  "id" | "type" | "title" | "createdAt" | "updatedAt"
>;

/** How a factory derives a tab's id from its input data. */
export type ChatPanelTabIdStrategy<TData> =
  | { type: "fixed"; id: string }
  | { type: "uuid"; prefix: string }
  | { type: "keyed"; prefix: string; getKey: (data: TData) => string };

export interface ChatPanelTabFactoryConfig<TData> {
  /** Tab type discriminant (must be a member of `ChatPanelTabType`). */
  tabType: ChatPanelTabType;
  /** How the tab id is generated. */
  idStrategy: ChatPanelTabIdStrategy<TData>;
  /** Stored (creation-time) title. Live display titles are still resolved by
   *  `resolveChatPanelTabDisplayTitle` from the session / i18n labels. */
  getTitle: (data: TData) => string;
  /** Type-specific payload fields (sessionId, workspace, workItem, …). */
  toPayload?: (data: TData) => ChatPanelTabPayload;
}

function resolveTabId<TData>(
  strategy: ChatPanelTabIdStrategy<TData>,
  data: TData
): string {
  switch (strategy.type) {
    case "fixed":
      return strategy.id;
    case "uuid":
      return `${strategy.prefix}-${crypto.randomUUID()}`;
    case "keyed":
      return `${strategy.prefix}:${strategy.getKey(data)}`;
  }
}

/**
 * Build a `(data) => ChatPanelTab` factory for one tab type. The returned
 * function stamps a fresh `createdAt`/`updatedAt` on each call.
 */
export function defineChatPanelTabFactory<TData = void>(
  config: ChatPanelTabFactoryConfig<TData>
): (data: TData) => ChatPanelTab {
  return (data: TData): ChatPanelTab => {
    const now = new Date().toISOString();
    return {
      id: resolveTabId(config.idStrategy, data),
      type: config.tabType,
      title: config.getTitle(data),
      createdAt: now,
      updatedAt: now,
      ...config.toPayload?.(data),
    };
  };
}
