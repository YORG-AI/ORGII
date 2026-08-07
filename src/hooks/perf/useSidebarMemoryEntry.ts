import { useEffect, useMemo, useRef } from "react";

import {
  type SidebarMemoryKind,
  estimateRuntimeValueBytes,
  removeSidebarMemoryEntry,
  updateSidebarMemoryEntry,
} from "./runtimeMemoryStats";

const SIDEBAR_BASE_RENDER_BYTES = 18 * 1024;
const SIDEBAR_ITEM_RENDER_BYTES = 720;
const SIDEBAR_SECTION_RENDER_BYTES = 512;
const SIDEBAR_TAB_RENDER_BYTES = 640;
const SIDEBAR_ESTIMATION_NODE_LIMIT = 800;

interface SidebarMemoryInput {
  kind: SidebarMemoryKind;
  label: string;
  items: number;
  sections?: number;
  tabs?: number;
  source?: unknown;
  extraBytes?: number;
  enabled?: boolean;
}

export function useSidebarMemoryEntry(input: SidebarMemoryInput): void {
  const key = useMemo(() => Symbol(input.label), [input.label]);

  // `source` is typically an inline object literal (fresh identity every
  // render). Listing it as an effect dep re-ran the estimation — a graph
  // walk of up to SIDEBAR_ESTIMATION_NODE_LIMIT nodes — on EVERY render,
  // which turned render storms into heavy CPU burn. The estimate is an
  // approximation keyed to the sidebar's shape, so re-running it when the
  // primitive shape inputs (items/sections/tabs/label/kind) change is
  // enough; the latest source is read through a ref.
  const sourceRef = useRef(input.source);
  useEffect(() => {
    sourceRef.current = input.source;
  });

  useEffect(() => {
    if (input.enabled === false) {
      removeSidebarMemoryEntry(key);
      return undefined;
    }

    const sections = input.sections ?? 0;
    const tabs = input.tabs ?? 0;
    const source = sourceRef.current;
    const sourceBytes = source
      ? estimateRuntimeValueBytes(source, SIDEBAR_ESTIMATION_NODE_LIMIT)
      : 0;
    const renderBytes =
      SIDEBAR_BASE_RENDER_BYTES +
      input.items * SIDEBAR_ITEM_RENDER_BYTES +
      sections * SIDEBAR_SECTION_RENDER_BYTES +
      tabs * SIDEBAR_TAB_RENDER_BYTES;

    updateSidebarMemoryEntry(key, input.kind, {
      bytes: sourceBytes + renderBytes + (input.extraBytes ?? 0),
      items: input.items,
      label: input.label,
    });

    return () => removeSidebarMemoryEntry(key);
  }, [
    input.enabled,
    input.extraBytes,
    input.items,
    input.kind,
    input.label,
    input.sections,
    input.tabs,
    key,
  ]);
}
