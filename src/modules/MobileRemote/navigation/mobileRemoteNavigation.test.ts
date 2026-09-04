import { describe, expect, it } from "vitest";

import {
  createInitialMobileRemoteNavState,
  reduceMobileRemoteNav,
} from "./mobileRemoteNavigation";

describe("mobileRemoteNavigation", () => {
  it("starts on welcome", () => {
    const state = createInitialMobileRemoteNavState();
    expect(state.screen).toBe("welcome");
    expect(state.activeTab).toBe("sessions");
    expect(state.stopModalOpen).toBe(false);
    expect(state.pendingConfig).toBeNull();
  });

  it("opens QR scan from welcome", () => {
    const state = reduceMobileRemoteNav(createInitialMobileRemoteNavState(), {
      type: "open_qr_scan",
    });
    expect(state.screen).toBe("qr_scan");
  });

  it("accepts Phase 0 LAN config and skips SAS", () => {
    const state = reduceMobileRemoteNav(createInitialMobileRemoteNavState(), {
      type: "accept_pairing",
      config: { host: "192.168.1.10", port: 13847, token: "secret" },
      requiresSas: false,
    });
    expect(state.screen).toBe("connecting");
    expect(state.pendingConfig).toEqual({
      host: "192.168.1.10",
      port: 13847,
      token: "secret",
    });
  });

  it("accepts Phase 1 relay config and requires SAS", () => {
    const state = reduceMobileRemoteNav(createInitialMobileRemoteNavState(), {
      type: "accept_pairing",
      config: { wsUrl: "wss://relay.example.com" },
      requiresSas: true,
      sasPhrase: "amber-falcon-42",
    });
    expect(state.screen).toBe("sas");
    expect(state.sasPhrase).toBe("amber-falcon-42");
  });

  it("runs Flow A: welcome → sas → connecting → sessions", () => {
    let state = createInitialMobileRemoteNavState();
    state = reduceMobileRemoteNav(state, {
      type: "scan_qr_demo",
      sasPhrase: "amber-falcon-42",
    });
    expect(state.screen).toBe("sas");

    state = reduceMobileRemoteNav(state, { type: "confirm_sas" });
    expect(state.screen).toBe("connecting");

    state = reduceMobileRemoteNav(state, { type: "connecting_complete" });
    expect(state.screen).toBe("sessions");
    expect(state.activeTab).toBe("sessions");
  });

  it("runs Flow B: sessions → chat", () => {
    let state = createInitialMobileRemoteNavState({ screen: "sessions" });
    state = reduceMobileRemoteNav(state, {
      type: "select_session",
      sessionId: "fix-auth-tests",
    });
    expect(state.screen).toBe("chat");
    expect(state.selectedSessionId).toBe("fix-auth-tests");
    expect(state.stopModalOpen).toBe(false);
  });

  it("clears session when leaving chat", () => {
    const state = reduceMobileRemoteNav(
      createInitialMobileRemoteNavState({
        screen: "chat",
        selectedSessionId: "fix-auth-tests",
        stopModalOpen: true,
      }),
      { type: "back_from_chat" }
    );
    expect(state.screen).toBe("sessions");
    expect(state.selectedSessionId).toBeNull();
    expect(state.stopModalOpen).toBe(false);
  });

  it("switches tabs on the sessions screen", () => {
    let state = createInitialMobileRemoteNavState({ screen: "sessions" });
    state = reduceMobileRemoteNav(state, { type: "set_tab", tab: "devices" });
    expect(state.activeTab).toBe("devices");

    state = reduceMobileRemoteNav(state, { type: "set_tab", tab: "settings" });
    expect(state.activeTab).toBe("settings");
  });

  it("closes stop modal when switching tabs", () => {
    const state = reduceMobileRemoteNav(
      createInitialMobileRemoteNavState({
        screen: "sessions",
        stopModalOpen: true,
      }),
      { type: "set_tab", tab: "devices" }
    );
    expect(state.stopModalOpen).toBe(false);
  });

  it("opens and closes stop modal on chat", () => {
    let state = createInitialMobileRemoteNavState({
      screen: "chat",
      selectedSessionId: "fix-auth-tests",
    });
    state = reduceMobileRemoteNav(state, { type: "open_stop_modal" });
    expect(state.stopModalOpen).toBe(true);

    state = reduceMobileRemoteNav(state, { type: "close_stop_modal" });
    expect(state.stopModalOpen).toBe(false);
  });

  it("returns to welcome and clears pending config on retry", () => {
    const state = reduceMobileRemoteNav(
      createInitialMobileRemoteNavState({
        screen: "connecting",
        pendingConfig: { host: "192.168.1.10", token: "x" },
      }),
      { type: "back_to_welcome" }
    );
    expect(state.screen).toBe("welcome");
    expect(state.pendingConfig).toBeNull();
  });
});
