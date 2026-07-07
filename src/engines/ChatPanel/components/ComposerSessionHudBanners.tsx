import React, { memo } from "react";

import {
  ChatRetryBanner,
  toChatRetryKind,
} from "@src/engines/ChatPanel/components/ChatStatusBanners";
import ComposerSessionStatusBanners from "@src/engines/ChatPanel/components/ComposerSessionStatusBanners";
import type { StreamRetryStatus } from "@src/store/session/cliSessionStatusAtom";

interface ComposerSessionHudBannersProps {
  sessionId: string;
  streamRetry: StreamRetryStatus | null;
}

/**
 * Session HUD stack above the composer: runtime failure/installing banners,
 * streaming activity HUD, and optional stream-retry footer.
 */
const ComposerSessionHudBanners: React.FC<ComposerSessionHudBannersProps> =
  memo(({ sessionId, streamRetry }) => (
    <>
      <ComposerSessionStatusBanners
        sessionId={sessionId}
        hasStreamRetry={Boolean(streamRetry)}
      />
      {streamRetry && (
        <ChatRetryBanner
          kind={toChatRetryKind(streamRetry.kind)}
          attempt={streamRetry.attempt}
          maxAttempts={streamRetry.maxAttempts}
        />
      )}
    </>
  ));

ComposerSessionHudBanners.displayName = "ComposerSessionHudBanners";

export default ComposerSessionHudBanners;
