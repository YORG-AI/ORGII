import React from "react";

import { MobileRemoteRoot } from "./MobileRemoteRoot";
import { getBrowserMobileRemotePlatform } from "./platform/browser";

const browserPlatform = getBrowserMobileRemotePlatform();
browserPlatform.auth.captureInitialPairingIntent();

/** Browser/main-router adapter. Native shells inject their own platform port. */
export default function BrowserMobileRemotePage() {
  return <MobileRemoteRoot platform={browserPlatform} />;
}

BrowserMobileRemotePage.displayName = "BrowserMobileRemotePage";
