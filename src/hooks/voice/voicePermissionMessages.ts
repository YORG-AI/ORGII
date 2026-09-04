import type { TFunction } from "i18next";

import { isIOS } from "@src/util/platform/isIOS";
import { isStandalonePWA } from "@src/util/platform/isStandalonePWA";

/** Resolves the microphone permission error copy for the current platform. */
export function resolveVoicePermissionErrorMessage(
  tVoice: TFunction<"sessions", "input">
): string {
  if (isIOS()) {
    if (isStandalonePWA()) {
      return tVoice(
        "voiceErrorPermissionIosPwa",
        "Microphone access denied. Open Settings → ORGII Mobile → Microphone, then return and try again."
      );
    }
    return tVoice(
      "voiceErrorPermissionIosSafari",
      "Microphone access denied. Open Settings → Safari → Microphone, then return and try again."
    );
  }
  return tVoice(
    "voiceErrorPermission",
    "Microphone permission denied. Enable it in your OS settings."
  );
}
