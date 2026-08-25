/**
 * CodeMirrorEditor Component
 *
 * A wrapper around CodeMirror 6 for code editing with native syntax highlighting.
 * Provides a consistent interface for file editing in Lite IDE.
 *
 * Features:
 * - Native CodeMirror syntax highlighting via Lezer parsers
 * - Autocomplete support
 * - Line numbers
 * - Theme support (light/dark)
 * - Keyboard shortcuts
 * - Dirty diff gutter (when originalValue is provided)
 *
 * Performance optimizations:
 * - Extensions use refs for callbacks to prevent recreation on callback changes
 * - Extensions array only recreates when file path, language, theme, or feature flags change
 * - Callback refs are updated without triggering extension rebuilds
 */
import CodeMirror from "@uiw/react-codemirror";
import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
} from "react";

import { CustomScrollbar } from "@src/components/CustomScrollbar";
import { useGitBlame } from "@src/hooks/git/useGitBlame";
import {
  removeCodeMirrorMemoryEntry,
  updateCodeMirrorMemoryEntry,
} from "@src/hooks/perf/runtimeMemoryStats";
import { useEditorAppearanceSettings } from "@src/hooks/settings";

import { BASIC_SETUP_CONFIG, getCodeMirrorTheme } from "../config";
import {
  useCopyExtension,
  useCursorExtension,
  useEditorExtensions,
  useEditorServiceRegistration,
  useLargeFileHandling,
  useLazyLanguageExtension,
  useSelectionExtension,
} from "./hooks";
import "./index.scss";
import type { CallbackRefs, CodeMirrorEditorProps } from "./types";

const MAX_SCROLL_STATE_ENTRIES = 100;
const editorScrollTopByKey = new Map<string, number>();

function rememberEditorScrollTop(key: string, scrollTop: number): void {
  if (editorScrollTopByKey.has(key)) {
    editorScrollTopByKey.delete(key);
  }
  editorScrollTopByKey.set(key, scrollTop);
  if (editorScrollTopByKey.size > MAX_SCROLL_STATE_ENTRIES) {
    const oldestKey = editorScrollTopByKey.keys().next().value;
    if (oldestKey) editorScrollTopByKey.delete(oldestKey);
  }
}

function canUseEditorScrollState(scrollElement: HTMLElement): boolean {
  return (
    scrollElement.isConnected &&
    scrollElement.clientHeight > 0 &&
    scrollElement.getClientRects().length > 0
  );
}

function restoreEditorScrollTop(
  scrollElement: HTMLElement,
  scrollTop: number
): boolean {
  if (!canUseEditorScrollState(scrollElement)) return false;
  const maxScrollTop = Math.max(
    0,
    scrollElement.scrollHeight - scrollElement.clientHeight
  );
  if (maxScrollTop <= 0 && scrollTop > 0) return false;
  scrollElement.scrollTop = Math.min(scrollTop, maxScrollTop);
  return true;
}

// Re-export types for consumers
export type {
  CodeMirrorEditorProps,
  CursorPosition,
  TextSelectionInfo,
} from "./types";

// ============================================
// Main Component
// ============================================

export const CodeMirrorEditor: React.FC<CodeMirrorEditorProps> = ({
  value,
  originalValue,
  filePath,
  language,
  height: _height = "100%",
  readOnly = false,
  onChange,
  onCursorChange,
  onTextSelection,
  className = "",
  enableMinimap: enableMinimapProp,
  enableIndentGuides: enableIndentGuidesProp,
  enableGoToLine = true,
  enableFindReplace = true,
  enableDirtyDiff = true,
  isDeletedFile = false,
  registerWithService = true,
  enableGitBlame = false,
  repoPath,
  lineNumberStart,
}) => {
  // ============================================
  // APPEARANCE SETTINGS: Read from global store
  // Props can override global settings when explicitly provided
  // ============================================
  const appearanceSettings = useEditorAppearanceSettings();

  // Merge global settings with props (props take precedence when defined)
  const enableMinimap = enableMinimapProp ?? appearanceSettings.showMinimap;
  const enableIndentGuides =
    enableIndentGuidesProp ?? appearanceSettings.showIndentGuides;

  // ============================================
  // GIT BLAME: Fetch blame data for inline annotations
  // ============================================
  const { blameDataRef } = useGitBlame({
    filePath,
    repoPath,
    enabled: enableGitBlame,
  });

  // ============================================
  // REFS
  // ============================================
  const containerRef = useRef<HTMLDivElement>(null);
  const minimapHostRef = useRef<HTMLDivElement>(null);
  const memoryStatsKeyRef = useRef(Symbol("codemirror-memory"));
  const scrollStateKey = filePath || language || null;
  const latestScrollStateKeyRef = useRef(scrollStateKey);
  latestScrollStateKeyRef.current = scrollStateKey;

  // ============================================
  // EDITOR SERVICE: Register EditorView for AI/service access
  // ============================================
  const { handleCreateEditor, scrollElement, totalLines } =
    useEditorServiceRegistration({
      registerWithService,
    });

  useLayoutEffect(() => {
    if (!scrollElement || !scrollStateKey) return;

    const effectScrollStateKey = scrollStateKey;
    const savedScrollTop = editorScrollTopByKey.get(effectScrollStateKey);
    const frameIds: number[] = [];
    let restoring = savedScrollTop !== undefined;
    const scheduleRestore = (remainingAttempts: number) => {
      const frameId = window.requestAnimationFrame(() => {
        if (savedScrollTop === undefined) return;
        if (latestScrollStateKeyRef.current !== effectScrollStateKey) return;
        const restored = restoreEditorScrollTop(scrollElement, savedScrollTop);
        if (restored) {
          restoring = false;
        } else if (remainingAttempts > 0) {
          scheduleRestore(remainingAttempts - 1);
        }
      });
      frameIds.push(frameId);
    };

    scheduleRestore(4);

    const handleScroll = () => {
      if (restoring) return;
      if (latestScrollStateKeyRef.current !== effectScrollStateKey) return;
      if (!canUseEditorScrollState(scrollElement)) return;
      rememberEditorScrollTop(effectScrollStateKey, scrollElement.scrollTop);
    };

    scrollElement.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      if (
        latestScrollStateKeyRef.current === effectScrollStateKey &&
        canUseEditorScrollState(scrollElement)
      ) {
        rememberEditorScrollTop(effectScrollStateKey, scrollElement.scrollTop);
      }
      frameIds.forEach((frameId) => window.cancelAnimationFrame(frameId));
      scrollElement.removeEventListener("scroll", handleScroll);
    };
  }, [scrollElement, scrollStateKey]);

  useEffect(() => {
    const key = memoryStatsKeyRef.current;
    updateCodeMirrorMemoryEntry(key, {
      bytes: value.length * 2 + (originalValue?.length ?? 0) * 2,
      items: totalLines || 1,
      label: filePath || language || "untitled",
    });
    return () => removeCodeMirrorMemoryEntry(key);
  }, [filePath, language, originalValue, totalLines, value]);

  // ============================================
  // LARGE FILE HANDLING: Auto-disable expensive features
  // ============================================
  const { effectiveMinimap, effectiveIndentGuides } = useLargeFileHandling({
    value,
    enableMinimap,
    enableIndentGuides,
  });

  // ============================================
  // LAZY LOADING: Language extension
  // ============================================
  const lazyLangExtension = useLazyLanguageExtension({ filePath, language });

  // ============================================
  // PERFORMANCE OPTIMIZATION: Use refs for callbacks
  // This prevents extension recreation when callbacks change
  // ============================================
  const callbackRefs = useRef<CallbackRefs>({});

  // Update refs on every render (cheap, no re-renders triggered)
  useEffect(() => {
    callbackRefs.current = {
      onCursorChange,
      onTextSelection,
      onChange,
      filePath,
    };
  });

  // ============================================
  // DIRTY DIFF: Ref for original value
  // ============================================
  const originalValueRef = useRef<string>(originalValue ?? "");

  // Update ref in effect (not during render) to satisfy React purity rules
  useEffect(() => {
    originalValueRef.current = originalValue ?? "";
  }, [originalValue]);

  // ============================================
  // EXTENSIONS: Individual extension hooks
  // ============================================
  const hasCursorCallback = !!onCursorChange;
  const hasSelectionCallback = !!onTextSelection;

  const cursorExtension = useCursorExtension(callbackRefs, hasCursorCallback);
  const selectionExtension = useSelectionExtension(
    callbackRefs,
    hasSelectionCallback
  );
  const copyExtension = useCopyExtension(callbackRefs, filePath);

  // ============================================
  // EXTENSIONS: Build complete extensions array
  // ============================================
  const extensions = useEditorExtensions({
    originalValueRef,
    enableDirtyDiff,
    originalValue,
    isDeletedFile,
    enableGoToLine,
    enableFindReplace,
    effectiveMinimap,
    effectiveIndentGuides,
    lazyLangExtension,
    cursorExtension,
    selectionExtension,
    copyExtension,
    minimapHostRef,
    enableGitBlame,
    blameDataRef,
    lineNumberStart,
  });

  // ============================================
  // HANDLERS
  // ============================================
  const handleChange = useCallback((newValue: string) => {
    callbackRefs.current.onChange?.(newValue);
  }, []);

  // ============================================
  // THEME
  // ============================================
  const theme = getCodeMirrorTheme();

  // The minimap extension renders into a sibling host outside CodeMirror's DOM.
  // Remount the editor when the host is added/removed so the view plugin and
  // the external host lifecycle stay in sync.
  const editorInstanceKey = effectiveMinimap ? "minimap-on" : "minimap-off";

  // Dynamic basicSetup config based on appearance settings.
  // When an offset gutter is active (ranged excerpt), the custom lineNumbers
  // extension in useEditorExtensions replaces basicSetup's gutter entirely.
  const hasOffsetGutter = !!lineNumberStart && lineNumberStart > 1;
  const basicSetupConfig = useMemo(
    () => ({
      ...BASIC_SETUP_CONFIG,
      lineNumbers: appearanceSettings.lineNumbers === "on" && !hasOffsetGutter,
      highlightActiveLine: appearanceSettings.highlightActiveLine,
      highlightActiveLineGutter: appearanceSettings.highlightActiveLine,
    }),
    [
      appearanceSettings.lineNumbers,
      appearanceSettings.highlightActiveLine,
      hasOffsetGutter,
    ]
  );

  // ============================================
  // RENDER
  // ============================================
  return (
    <div
      ref={containerRef}
      className={`codemirror-editor-wrapper ${className}`}
    >
      {/* Flex container for editor + minimap */}
      <div className="codemirror-editor-shell">
        {/* Main editor */}
        <div className="codemirror-editor">
          <CodeMirror
            key={editorInstanceKey}
            value={value}
            height="100%"
            style={{ height: "100%", flex: 1, minHeight: 0 }}
            theme={theme}
            extensions={extensions}
            onChange={handleChange}
            readOnly={readOnly}
            basicSetup={basicSetupConfig}
            onCreateEditor={handleCreateEditor}
          />
        </div>

        {/* Minimap host - sibling element for proper flex layout */}
        {effectiveMinimap && (
          <div ref={minimapHostRef} className="codemirror-minimap-host" />
        )}
      </div>
      <CustomScrollbar scrollElement={scrollElement} totalLines={totalLines} />
    </div>
  );
};

CodeMirrorEditor.displayName = "CodeMirrorEditor";

export default CodeMirrorEditor;
