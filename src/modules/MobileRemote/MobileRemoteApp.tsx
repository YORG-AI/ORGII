import React, {
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useState,
} from "react";

import { MobileRemoteProviders, useMobileRemote } from "./app";
import { MobileAuthGate } from "./auth/MobileAuthGate";
import { MobileShell } from "./components/MobileShell";
import { MobileTabBar } from "./components/MobileTabBar";
import { StopConfirmModal } from "./components/modals/StopConfirmModal";
import { parseMobileRemoteWsUrl } from "./connection/parseMobileRemoteWsUrl";
import type { MobileConnectionConfig } from "./connection/types";
import { DEMO_SAS_PHRASE } from "./demo/demoFixtures";
import { resolveMobileSessionTitle } from "./lib/sessionPresentation";
import {
  createInitialMobileRemoteNavState,
  reduceMobileRemoteNav,
} from "./navigation/mobileRemoteNavigation";
import { ConnectingLiveBridge } from "./screens/ConnectingLiveBridge";
import { ConnectionErrorScreen } from "./screens/ConnectionErrorScreen";
import { QRScanScreen } from "./screens/QRScanScreen";
import { SASConfirmScreen } from "./screens/SASConfirmScreen";
import { SessionChatScreen } from "./screens/SessionChatScreen";
import { SessionsScreen } from "./screens/SessionsScreen";
import { WelcomeScreen } from "./screens/WelcomeScreen";
import { DevicesTab } from "./screens/devices/DevicesTab";
import { SettingsTab } from "./screens/settings/SettingsTab";

export interface MobileRemoteAppProps {
  authUserId: string;
  /** Credential-bearing pairing URL captured opaquely before authentication. */
  recoveredPairingIntent?: string | null;
  /** Relay WebSocket URL — when set, skips demo fixtures. */
  relayUrl?: string;
}

interface MobileRemoteRoutesProps {
  recoveredPairingIntent: string | null;
}

function MobileRemoteRoutes({
  recoveredPairingIntent,
}: MobileRemoteRoutesProps) {
  const { connection, sessions, stopSession, disconnect } = useMobileRemote();
  const [nav, dispatch] = useReducer(
    reduceMobileRemoteNav,
    undefined,
    createInitialMobileRemoteNavState
  );
  const [stopConfirming, setStopConfirming] = useState(false);
  const consumedPairingLinkRef = useRef(false);

  const showTabBar =
    nav.screen === "sessions" &&
    connection.status === "connected" &&
    !nav.selectedSessionId;
  const selectedSessionName = nav.selectedSessionId
    ? resolveMobileSessionTitle(sessions, nav.selectedSessionId)
    : "";
  const selectedSessionSendCapability = nav.selectedSessionId
    ? sessions.find((session) => session.id === nav.selectedSessionId)
        ?.sendCapability
    : undefined;

  useEffect(() => {
    if (
      connection.status === "connected" &&
      !connection.demoMode &&
      nav.screen === "welcome"
    ) {
      dispatch({ type: "connecting_complete" });
    }
  }, [connection.demoMode, connection.status, nav.screen]);

  useEffect(() => {
    if (consumedPairingLinkRef.current || !recoveredPairingIntent) return;
    consumedPairingLinkRef.current = true;
    const parsed = parseMobileRemoteWsUrl(recoveredPairingIntent);
    if (parsed.ok) {
      dispatch({ type: "accept_pairing", ...parsed });
    }
  }, [recoveredPairingIntent]);

  const handleScanDemo = useCallback(() => {
    dispatch({ type: "scan_qr_demo", sasPhrase: DEMO_SAS_PHRASE });
  }, []);

  const handleConnectingComplete = useCallback(() => {
    dispatch({ type: "connecting_complete" });
  }, []);

  const handleAcceptPairing = useCallback(
    (args: {
      config: MobileConnectionConfig;
      requiresSas: boolean;
      sasPhrase?: string;
    }) => {
      dispatch({ type: "accept_pairing", ...args });
    },
    []
  );

  const handleConfirmStop = useCallback(async () => {
    if (!nav.selectedSessionId) return;
    setStopConfirming(true);
    try {
      await stopSession(nav.selectedSessionId);
    } finally {
      setStopConfirming(false);
      dispatch({ type: "close_stop_modal" });
    }
  }, [nav.selectedSessionId, stopSession]);

  const handleConnectionRetry = useCallback(() => {
    disconnect();
    dispatch({ type: "back_to_welcome" });
  }, [disconnect]);

  if (connection.status === "error") {
    return (
      <MobileShell>
        <ConnectionErrorScreen
          message={connection.error?.message}
          onRetry={handleConnectionRetry}
        />
      </MobileShell>
    );
  }

  let body: React.ReactNode;
  switch (nav.screen) {
    case "welcome":
      body = (
        <WelcomeScreen
          onOpenPairing={() => dispatch({ type: "open_qr_scan" })}
          onScanDemo={handleScanDemo}
        />
      );
      break;
    case "qr_scan":
      body = (
        <QRScanScreen
          onBack={() => dispatch({ type: "back_from_qr_scan" })}
          onAcceptPairing={handleAcceptPairing}
        />
      );
      break;
    case "sas":
      body = (
        <SASConfirmScreen
          phrase={nav.sasPhrase}
          onBack={() => dispatch({ type: "back_from_sas" })}
          onConfirm={() => dispatch({ type: "confirm_sas" })}
        />
      );
      break;
    case "connecting":
      body = (
        <ConnectingLiveBridge
          pendingConfig={nav.pendingConfig}
          demoMode={connection.demoMode}
          onComplete={handleConnectingComplete}
        />
      );
      break;
    case "sessions":
    case "chat":
      if (nav.selectedSessionId) {
        body = (
          <>
            <SessionChatScreen
              sessionId={nav.selectedSessionId}
              sessionName={selectedSessionName}
              sendCapability={selectedSessionSendCapability}
              onBack={() => dispatch({ type: "back_from_chat" })}
              onOpenStopModal={() => dispatch({ type: "open_stop_modal" })}
            />
            <StopConfirmModal
              visible={nav.stopModalOpen}
              confirming={stopConfirming}
              onCancel={() => dispatch({ type: "close_stop_modal" })}
              onConfirm={() => void handleConfirmStop()}
            />
          </>
        );
      } else if (nav.activeTab === "devices") {
        body = <DevicesTab />;
      } else if (nav.activeTab === "settings") {
        body = <SettingsTab />;
      } else {
        body = (
          <SessionsScreen
            onSelectSession={(sessionId) =>
              dispatch({ type: "select_session", sessionId })
            }
          />
        );
      }
      break;
    default:
      body = null;
  }

  return (
    <MobileShell
      footer={
        showTabBar ? (
          <MobileTabBar
            active={nav.activeTab}
            onChange={(tab) => dispatch({ type: "set_tab", tab })}
          />
        ) : null
      }
    >
      {body}
    </MobileShell>
  );
}

/** Mobile Remote PWA root. @see docs/mobile-remote-2026-08-28/UI-SPEC.md */
export function MobileRemoteApp({
  authUserId,
  recoveredPairingIntent = null,
  relayUrl,
}: MobileRemoteAppProps) {
  return (
    <MobileRemoteProviders
      authUserId={authUserId}
      relayUrl={relayUrl}
      demoByDefault={!relayUrl}
      suppressInitialBootstrap={recoveredPairingIntent !== null}
    >
      <MobileRemoteRoutes recoveredPairingIntent={recoveredPairingIntent} />
    </MobileRemoteProviders>
  );
}

MobileRemoteApp.displayName = "MobileRemoteApp";

/** Main-router compatibility wrapper. The standalone entry uses the same gate explicitly. */
function AuthenticatedMobileRemotePage() {
  return (
    <MobileAuthGate>
      {({ authUserId, recoveredPairingIntent }) => (
        <MobileRemoteApp
          authUserId={authUserId}
          recoveredPairingIntent={recoveredPairingIntent}
        />
      )}
    </MobileAuthGate>
  );
}

AuthenticatedMobileRemotePage.displayName = "AuthenticatedMobileRemotePage";

export default AuthenticatedMobileRemotePage;
