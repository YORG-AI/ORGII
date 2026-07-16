/**
 * Universal Event Props
 *
 * Shared prop interface for all event components across all contexts.
 * Components receive normalized data and render based on `variant`.
 *
 * Two visual styles:
 * - `chat`: Chat panel styling (conversation flow, inline with messages)
 * - `simulator`: Simulator/Trajectory styling (event cards, technical look)
 */
import type {
  ExtractedData,
  LlmUsageMetadata,
  PayloadRef,
  ToolUsageMetadata,
} from "@src/engines/SessionCore/core/types";
import type { PlanSurface } from "@src/engines/SessionCore/derived/planDisplayEvents";

// ============================================
// Visual Variants
// ============================================

/**
 * Visual rendering variant
 * - chat: Chat panel style (conversation bubbles, inline)
 * - simulator: Simulator/Trajectory style (event cards, technical)
 */
export type EventVariant = "chat" | "simulator";

/**
 * Rendering context (where the component is being used)
 * Note: trajectory uses simulator variant but may have different behavior
 */
export type RenderContext = "chat" | "simulator" | "trajectory";

// ============================================
// Status Types
// ============================================

export type EventStatus =
  | "pending"
  | "running"
  | "success"
  | "failed"
  | "cancelled";

// ============================================
// Animation Config
// ============================================

export interface AnimationConfig {
  enableTypewriter?: boolean;
  typewriterConfig?: {
    lineByLine?: boolean;
    linesPerFrame?: number;
    frameInterval?: number;
    initialDelay?: number;
  };
  enableAutoScroll?: boolean;
  autoScrollConfig?: {
    pixelsPerFrame?: number;
    frameInterval?: number;
    initialDelay?: number;
  };
  autoScrollLoop?: boolean;
}

// ============================================
// Universal Event Props
// ============================================

export interface UniversalEventProps {
  // ─────────────────────────────────────────
  // Core Identity
  // ─────────────────────────────────────────
  /** Unique event identifier */
  eventId: string;
  /** Event type — Rust `ui_canonical` (e.g., "thinking", "read_file", "mcp_tool") */
  eventType: string;
  /**
   * Raw function name from the event source (before ui_canonical resolution).
   * For MCP tools this is the external server's tool name (e.g., "weather_lookup"),
   * which differs from `eventType === "mcp_tool"`. Blocks that need the original
   * name for display should prefer this field.
   */
  functionName?: string;
  /**
   * Per-tool-call identifier (`SessionEvent.callId`). Required to correlate
   * out-of-band signals (MCP progress ticks, permission prompts, etc.) back
   * to the chat bubble for this tool. Absent on non-tool events.
   */
  callId?: string;
  /** Token/context attribution metadata for this tool call. */
  toolUsage?: ToolUsageMetadata;
  /** Token usage metadata for the LLM span represented by this event. */
  llmUsage?: LlmUsageMetadata;
  /** File path for file operations, when emitted as top-level event metadata. */
  filePath?: string;
  /** Repository filesystem path active when this event was emitted. */
  repoPath?: string;
  /**
   * Session the event belongs to. Needed alongside `callId` for cross-session
   * stores (e.g. `mcpProgressMapAtom`) so the render layer doesn't need to
   * thread the currently-filtered session through every adapter.
   */
  sessionId?: string;

  // ─────────────────────────────────────────
  // Data
  // ─────────────────────────────────────────
  /** Event arguments/inputs */
  args: Record<string, unknown>;
  /** Event result/output */
  result: Record<string, unknown>;
  /** Current status */
  status: EventStatus;
  /** Timestamp */
  timestamp?: string;
  /** Whether active-state visual treatment should be shown for running/pending events. */
  showActiveEventPainting?: boolean;
  /** Shell process PID attached by shell process lifecycle events. */
  shellPid?: number;
  /** Shell process status attached by shell process lifecycle events. */
  shellProcessStatus?: "running" | "background" | "exited" | "killed";
  /** Shell process exit code attached by shell process lifecycle events. */
  shellExitCode?: number;
  /** Shell process log path attached by shell process lifecycle events. */
  shellLogPath?: string;

  // ─────────────────────────────────────────
  // Rendering Control
  // ─────────────────────────────────────────
  /** Visual variant: chat or simulator style */
  variant: EventVariant;
  /** Rendering context */
  context: RenderContext;

  // ─────────────────────────────────────────
  // Interaction (mainly for trajectory)
  // ─────────────────────────────────────────
  /** Whether this event is currently selected */
  isSelected?: boolean;
  /** Callback when event is selected */
  onSelect?: () => void;

  // ─────────────────────────────────────────
  // Animation (simulator only)
  // ─────────────────────────────────────────
  /** Animation configuration */
  animation?: AnimationConfig;

  // ─────────────────────────────────────────
  // Chat-specific
  // ─────────────────────────────────────────
  /** Item index in chat history */
  itemIndex?: number;
  /** Streaming content (for real-time updates) */
  streamingContent?: string;
  /** Whether content is currently streaming */
  isStreaming?: boolean;
  /** Plan approval surface used to derive ownership of Build/Edit/Skip actions. */
  planSurface?: PlanSurface;

  /**
   * Rust-computed typed payload for this event. Present when the event
   * comes from a SessionEvent wire (chat path); may be absent in
   * simulator/trajectory paths that build raw activity shapes. TS-side
   * extractors prefer this when available and fall back to parsing
   * `args`/`result` otherwise.
   */
  rustExtracted?: ExtractedData;

  payloadRefs?: PayloadRef[];
}

// ============================================
// Extracted Data Types (computed from args/result)
// ============================================

export interface ExtractedThinkingData {
  content?: string;
  duration?: number;
}

export interface ExtractedFileData {
  filePath: string;
  fileName: string;
  content?: string;
  language?: string;
  lineCount?: number;
  /** 1-indexed first line of a ranged read (offset/limit); 1 or absent = from top. */
  startLine?: number;
}

export interface ExtractedEditData extends ExtractedFileData {
  oldContent?: string;
  newContent?: string;
  diff?: string;
  oldStartLine?: number;
  newStartLine?: number;
  linesAdded?: number;
  linesRemoved?: number;
  /** File was deleted (apply_patch `*** Delete File` segment). */
  isDeleted?: boolean;
  /**
   * apply_patch: one extracted block per `*** Add/Modify/Delete File` section.
   * Prefer rendering these instead of the top-level fields when present.
   */
  applyPatchSegments?: ExtractedEditData[];
}

/** Mirrors Rust `PatchSegment` (serde camelCase). */
export interface RustPatchSegment {
  filePath: string;
  diff: string;
  linesAdded: number;
  linesRemoved: number;
  isDeleted: boolean;
  hasExplicitHunkHeader?: boolean;
}

/** Mirrors Rust `PatchConversionResult` (serde camelCase). */
export interface RustPatchConversionResult {
  diff: string;
  linesAdded: number;
  linesRemoved: number;
  filePaths: string[];
  segments: RustPatchSegment[];
}

export interface ExtractedShellData {
  command: string;
  shortCommand?: string;
  commandKeywords?: string;
  action?: string;
  killHandle?: string;
  description?: string;
  output?: string;
  streamOutput?: string;
  exitCode?: number;
  cwd?: string;
  executionTime?: number;
  isFailure?: boolean;
  // Shell process state (from ShellProcessStarted/Exited events)
  shellPid?: number;
  shellProcessStatus?: "running" | "background" | "exited" | "killed";
  shellLogPath?: string;
}

export interface ExtractedSearchData {
  query: string;
  results?: Array<{
    file: string;
    line: number;
    content: string;
  }>;
  totalMatches?: number;
}

export interface ExtractedTodoData {
  todos: Array<{
    id: string;
    content: string;
    status: string;
    /** Present-continuous label preferred while the todo is in_progress. */
    activeForm?: string;
    blockedBy?: number[];
  }>;
  wasMerge?: boolean;
}

// ============================================
// Component Props (extends universal with extracted data)
// ============================================

export interface ThinkingEventProps extends UniversalEventProps {
  extracted: ExtractedThinkingData;
}

export interface FileEventProps extends UniversalEventProps {
  extracted: ExtractedFileData;
}

export interface EditEventProps extends UniversalEventProps {
  extracted: ExtractedEditData;
}

export interface ShellEventProps extends UniversalEventProps {
  extracted: ExtractedShellData;
}

export interface SearchEventProps extends UniversalEventProps {
  extracted: ExtractedSearchData;
}

export interface TodoEventProps extends UniversalEventProps {
  extracted: ExtractedTodoData;
}
