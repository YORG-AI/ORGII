import type { TurnSummary } from "@src/engines/SessionCore/storage/sqliteCache";

/** Shared prop contract for the derived per-session views (Timeline, Changes). */
export interface SessionDerivedViewProps {
  turns: TurnSummary[];
  loading: boolean;
  error: string | null;
  /** Space reserved for host chrome that overlays the view. */
  topInset?: number;
}
