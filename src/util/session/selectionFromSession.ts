/**
 * selectionFromSession — shared utility
 *
 * Projects a live session row + creator-default fallback into the
 * `LastModelSelection` shape that dispatchers consume.
 *
 * Previously duplicated in:
 *  - src/engines/SessionCore/hooks/session/useQueueDispatch.ts
 *  - src/engines/ChatPanel/hooks/useWorkspaceChat/useMessageDispatch.ts
 */
import { isHostedKey } from "@src/api/tauri/session";
import type { LastModelSelection } from "@src/store/session/creatorDefaultModelAtom";
import type { Session } from "@src/store/session/sessionAtom/types";

export function selectionFromSession(
  session: Session | undefined,
  fallback: LastModelSelection | null
): LastModelSelection | null {
  if (!session) return fallback;

  const keySource = session.keySource ?? fallback?.keySource;
  // Rust persists market sessions with `listingModel` written into
  // `code_sessions.model`, so we can read either as the market `model`
  // identifier without a separate column.
  const isHosted = isHostedKey(keySource);

  return {
    keySource,
    model: isHosted ? undefined : (session.model ?? fallback?.model),
    listingModel: isHosted
      ? (session.model ?? fallback?.listingModel)
      : undefined,
    selectedAccountId: session.accountId ?? fallback?.selectedAccountId,
    cliAgentType: session.cliAgentType ?? fallback?.cliAgentType,
    tier: session.tier ?? fallback?.tier,
    // Display-only fields: carry forward from fallback so the UI side
    // preserves whatever it last rendered.
    listingModelDisplay: fallback?.listingModelDisplay,
    listingModelType: fallback?.listingModelType,
    listingName: fallback?.listingName,
    selectedSourceLabel: fallback?.selectedSourceLabel,
    selectedSourceModelType: fallback?.selectedSourceModelType,
    provider: fallback?.provider,
  };
}
