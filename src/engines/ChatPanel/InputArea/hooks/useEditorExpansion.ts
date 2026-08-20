import { type RefObject, useCallback, useEffect, useState } from "react";

interface UseEditorExpansionOptions {
  enabled: boolean;
  compactEligible: boolean;
  containerRef: RefObject<HTMLElement | null>;
  handleContentChange: (text: string) => void;
  handleInputBlur: () => void;
}

interface UseEditorExpansionReturn {
  editorMultiline: boolean;
  onEditorContentChange: (text: string) => void;
  onEditorBlur: () => void;
}

function measureContentWidth(host: HTMLElement): number {
  if (!host.firstChild) return 0;
  const range = document.createRange();
  try {
    range.selectNodeContents(host);
    const rects = range.getClientRects();
    let width = 0;
    for (let index = 0; index < rects.length; index += 1) {
      width = Math.max(width, rects[index].width);
    }
    return width;
  } finally {
    range.detach?.();
  }
}

/**
 * Expands contextual single-row editors when their document becomes
 * multiline or approaches the available width. Ordinary session composers
 * bypass the tracking path and keep the shared stacked layout.
 */
export function useEditorExpansion({
  enabled,
  compactEligible,
  containerRef,
  handleContentChange,
  handleInputBlur,
}: UseEditorExpansionOptions): UseEditorExpansionReturn {
  const [editorMultiline, setEditorMultiline] = useState(false);

  const onEditorContentChange = useCallback(
    (text: string) => {
      handleContentChange(text);
      if (!enabled) return;

      const content =
        containerRef.current?.querySelector<HTMLElement>(
          ".composer-input-content"
        ) ?? null;
      const hasPills = content?.querySelector("[data-composer-pill]") != null;

      if (hasPills || text.includes("\n")) {
        setEditorMultiline(true);
        return;
      }

      if (text.trim().length === 0) {
        setEditorMultiline(false);
        return;
      }

      if (!compactEligible || !content) return;
      const slot = content.closest<HTMLElement>("[data-editor-slot]");
      if (!slot || slot.clientWidth <= 0) return;
      if (measureContentWidth(content) / slot.clientWidth >= 0.8) {
        setEditorMultiline(true);
      }
    },
    [compactEligible, containerRef, enabled, handleContentChange]
  );

  const onEditorBlur = useCallback(() => {
    handleInputBlur();
  }, [handleInputBlur]);

  // ResizeObserver is the external browser resource synchronized here. It is
  // active only while a contextual editor can still use the compact row and
  // is disconnected symmetrically on expansion or unmount.
  useEffect(() => {
    if (!compactEligible || editorMultiline) return;
    const content =
      containerRef.current?.querySelector<HTMLElement>(
        ".composer-input-content"
      ) ?? null;
    const slot = content?.closest<HTMLElement>("[data-editor-slot]") ?? null;
    if (!content || !slot) return;

    const check = () => {
      if (slot.clientWidth <= 0) return;
      const text = (content.textContent ?? "").replace(/\u200b/g, "").trim();
      if (text.length === 0) return;
      if (measureContentWidth(content) / slot.clientWidth >= 0.8) {
        setEditorMultiline(true);
      }
    };

    check();
    const observer = new ResizeObserver(check);
    observer.observe(content);
    observer.observe(slot);
    return () => observer.disconnect();
  }, [compactEligible, containerRef, editorMultiline]);

  return {
    editorMultiline: enabled && editorMultiline,
    onEditorContentChange,
    onEditorBlur,
  };
}
