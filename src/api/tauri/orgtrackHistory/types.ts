export interface CursorSession {
  id: string;
  name: string;
  createdAt: number;
  lastActiveAt: number;
  status: string;
  isAgentic: boolean;
  mode: string;
  model: string;
  linesAdded: number;
  linesRemoved: number;
  filesChanged: number;
  tokensUsed: number;
  /** Estimated cost in USD (tokens × list price). */
  estimatedCost: number;
  /** Recorded metered cost in USD — 0 for token-only sources. */
  recordedCost: number;
}
