/**
 * Hosted Session Wire Types
 *
 * Wire shape returned by the hosted ORGII session endpoint when the user is
 * running a session through `KeySource = "hosted_key"`.
 *
 * Field names are wire-format (snake_case) and must match the hosted HTTP
 * contract; do not rebrand `market_*` field names without updating the
 * server side.
 */
import type { MarketSessionStatus } from "./session";

export interface SessionStatusResponse {
  session_id: string;
  status: MarketSessionStatus;
  listing_id?: string;
  listing_name?: string;
  agent_type?: string;
  started_at: string | null;
  completed_at: string | null;
  duration_seconds: number | null;
  tokens_input: number;
  tokens_output: number;
  cost_usd: number;
  output_preview: string | null;
  error: string | null;
  download_url: string | null;
  patch_url: string | null;
  repo_id?: string;
  // Optional fields from different API formats
  task?: string | null;
  name?: string | null;
  session_type?: string;
  tokens_used?: number;
  created_at?: string | null;
}
