import { useAtomValue } from "jotai";
import React, { memo } from "react";

import StreamingHud from "@src/engines/ChatPanel/InputArea/ChatHeader/StreamingHud";
import {
  SessionFailedBanner,
  SessionInstallingBanner,
} from "@src/engines/ChatPanel/components/ChatStatusBanners";
import {
  sessionRuntimeErrorAtom,
  sessionRuntimeStatusAtom,
} from "@src/store/session/cliSessionStatusAtom";
import { isCliSession } from "@src/util/session/sessionDispatch";

import {
  shouldShowComposerActivityHud,
  shouldShowSessionFailedBanner,
  shouldShowSessionInstallingBanner,
} from "./sessionStatusBannerHelpers";

interface ComposerSessionStatusBannersProps {
  sessionId: string;
  hasStreamRetry: boolean;
}

const ComposerSessionStatusBanners: React.FC<ComposerSessionStatusBannersProps> =
  memo(({ sessionId, hasStreamRetry }) => {
    const runtimeStatus = useAtomValue(sessionRuntimeStatusAtom);
    const runtimeError = useAtomValue(sessionRuntimeErrorAtom);

    if (shouldShowSessionFailedBanner(runtimeStatus)) {
      return (
        <SessionFailedBanner
          error={runtimeError}
          canRetry={isCliSession(sessionId)}
        />
      );
    }

    if (shouldShowSessionInstallingBanner(runtimeStatus)) {
      return <SessionInstallingBanner />;
    }

    if (
      shouldShowComposerActivityHud({
        runtimeStatus,
        hasStreamRetry,
      })
    ) {
      return <StreamingHud sessionId={sessionId} />;
    }

    return null;
  });

ComposerSessionStatusBanners.displayName = "ComposerSessionStatusBanners";

export default ComposerSessionStatusBanners;
