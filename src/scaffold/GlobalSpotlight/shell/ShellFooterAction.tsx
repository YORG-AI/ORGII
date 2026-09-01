import React, { useContext, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";

import {
  type FooterActionPlacement,
  SpotlightFooterActionContext,
} from "./footerActionContext";

/**
 * ShellFooterAction
 *
 * Portal used by palettes to inject footer content next to the
 * keyboard-hints footer rendered by SpotlightShell:
 *
 * - `placement="pill"` (default) — its own floating pill beside the hints
 *   (e.g. "Manage Models", "Manage Keys").
 * - `placement="inline"` — inside the hint pill itself, after the last
 *   hint (e.g. the "Show path" checkbox).
 *
 * If there is no SpotlightShell in the tree, renders nothing — callers
 * don't need to guard.
 *
 * Uses useSyncExternalStore so the portal target stays in sync with the
 * shell's host ref without any effect + setState dance.
 */
interface ShellFooterActionProps {
  children: React.ReactNode;
  placement?: FooterActionPlacement;
}

const emptySubscribe = () => () => {};
const emptyGetSnapshot = () => null;

export const ShellFooterAction: React.FC<ShellFooterActionProps> = ({
  children,
  placement = "pill",
}) => {
  const slots = useContext(SpotlightFooterActionContext);
  const slot = slots?.[placement];

  const target = useSyncExternalStore<HTMLDivElement | null>(
    slot?.subscribe ?? emptySubscribe,
    slot?.getSnapshot ?? emptyGetSnapshot,
    emptyGetSnapshot
  );

  if (!target) return null;
  return createPortal(children, target);
};

export default ShellFooterAction;
