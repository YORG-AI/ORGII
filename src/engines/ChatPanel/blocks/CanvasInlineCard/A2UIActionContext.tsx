/**
 * A2UIActionContext — React context for bidirectional action callbacks.
 *
 * When a button is clicked or a form is submitted inside the A2UI renderer,
 * the action bubbles up through this context to the host component, which
 * can then dispatch to the session or handle it directly.
 *
 * The host also emits a `canvas-action-event` on `window` so that other
 * layers (analytics, session dispatch wiring) can subscribe without prop
 * drilling.
 */
import React, { createContext, useContext } from "react";

export type A2UIActionHandler = (actionId: string, payload?: unknown) => void;

export const A2UIActionContext = createContext<A2UIActionHandler | undefined>(
  undefined
);

export function useA2UIAction(): A2UIActionHandler {
  const handler = useContext(A2UIActionContext);
  return handler ?? (() => {});
}

interface A2UIActionProviderProps {
  onAction?: A2UIActionHandler;
  sessionId?: string;
  children: React.ReactNode;
}

export const A2UIActionProvider: React.FC<A2UIActionProviderProps> = ({
  onAction,
  sessionId,
  children,
}) => {
  const handler: A2UIActionHandler = (actionId, payload) => {
    // Emit to window so other subscribers (analytics, session wiring) can listen
    window.dispatchEvent(
      new CustomEvent("canvas-action-event", {
        detail: { sessionId, actionId, payload },
      })
    );
    onAction?.(actionId, payload);
  };

  return (
    <A2UIActionContext.Provider value={handler}>
      {children}
    </A2UIActionContext.Provider>
  );
};
