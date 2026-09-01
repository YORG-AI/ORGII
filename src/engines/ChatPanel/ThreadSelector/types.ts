/**
 * Thread Selector Types
 *
 * Types for the execution stage thread selector feature.
 * The selector appears only during execution stages and allows
 * users to filter events by thread_id.
 */

/**
 * Represents a single thread in the execution stage
 */
export interface ExecutionThread {
  /** Unique thread identifier (e.g., "implement-html", "fix-css-colors") */
  threadId: string;

  /** Display name for the thread (derived from threadId) */
  displayName: string;

  /** Whether this thread is currently selected */
  isActive: boolean;

  /** Number of events in this thread */
  eventCount: number;

  /** Whether this thread has completed (has session_end) */
  isCompleted: boolean;

  /** Whether this thread is currently running (has session_start but no session_end) */
  isRunning: boolean;
}

/**
 * Props for the ThreadSelector component
 */
export interface ThreadSelectorProps {
  /** Available threads to select from */
  threads: ExecutionThread[];

  /** Currently selected thread ID (null = all) */
  selectedThreadId: string | null;

  /** Callback when a thread is selected */
  onSelectThread: (threadId: string | null) => void;

  /** Whether to show the "All" button */
  showAllOption?: boolean;

  /** Callback to navigate to a specific thread's first event */
  onNavigateToThread?: (threadId: string) => void;
}
