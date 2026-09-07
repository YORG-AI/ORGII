import { createContext, useContext } from "react";

import * as defaults from "@src/store/ui/collapseStateAtom";

export const ChatCollapseScope =
  createContext<ReturnType<typeof defaults.createCollapseState>>(defaults);
export const useChatCollapseState = () => useContext(ChatCollapseScope);

// Small UI state survives page switches without retaining any event bodies.
const scopes = new Map<
  string,
  ReturnType<typeof defaults.createCollapseState>
>();
export function getSubagentCollapseScope(sessionId: string) {
  const scope = scopes.get(sessionId) ?? defaults.createCollapseState();
  scopes.delete(sessionId);
  scopes.set(sessionId, scope);
  while (scopes.size > 200) {
    const oldest = scopes.keys().next().value;
    if (oldest === undefined) break;
    scopes.delete(oldest);
  }
  return scope;
}
