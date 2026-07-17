/**
 * useSourceControlAttention
 *
 * Tells the Rust git watcher whether a Source Control surface is currently
 * visible. While one is, focused git-status polling runs at the fast (5s)
 * interval; otherwise it relaxes to 10s so an idle app spawns half the git
 * subprocesses. Reference-counted so multiple simultaneous surfaces (main
 * pane + sidebar) can report independently without flapping the flag.
 */
import { invoke } from "@tauri-apps/api/core";
import { useEffect } from "react";

let attentionCount = 0;
let lastReported: boolean | null = null;

function syncAttention(): void {
  const visible = attentionCount > 0;
  if (visible === lastReported) return;
  lastReported = visible;
  invoke("set_source_control_attention", { visible }).catch(() => {
    // Watcher not initialized yet (early startup) — the next transition
    // re-reports; polling just stays on the relaxed interval until then.
    lastReported = null;
  });
}

export function useSourceControlAttention(visible: boolean): void {
  useEffect(() => {
    if (!visible) return;
    attentionCount += 1;
    syncAttention();
    return () => {
      attentionCount -= 1;
      syncAttention();
    };
  }, [visible]);
}
