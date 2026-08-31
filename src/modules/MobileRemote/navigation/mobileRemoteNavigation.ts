/**
 * Mobile Remote demo navigation — pure state machine for Phase 0 screens.
 * @see docs/mobile-remote-2026-08-28/UI-SPEC.md §1.6 Flow A/B
 */
import type { MobileConnectionConfig } from "../connection/types";

export type MobileRemoteScreen =
  | "welcome"
  | "qr_scan"
  | "sas"
  | "connecting"
  | "sessions"
  | "chat";

export type MobileRemoteTab = "sessions" | "devices" | "settings";

export interface MobileRemoteNavState {
  screen: MobileRemoteScreen;
  sasPhrase: string;
  pendingConfig: MobileConnectionConfig | null;
  requiresSas: boolean;
  selectedSessionId: string | null;
  activeTab: MobileRemoteTab;
  stopModalOpen: boolean;
}

export type MobileRemoteNavAction =
  | { type: "open_qr_scan" }
  | { type: "back_from_qr_scan" }
  | { type: "back_to_welcome" }
  | {
      type: "accept_pairing";
      config: MobileConnectionConfig;
      requiresSas: boolean;
      sasPhrase?: string;
    }
  | { type: "scan_qr_demo"; sasPhrase: string }
  | { type: "back_from_sas" }
  | { type: "confirm_sas" }
  | { type: "back_from_connecting" }
  | { type: "connecting_complete" }
  | { type: "select_session"; sessionId: string }
  | { type: "back_from_chat" }
  | { type: "set_tab"; tab: MobileRemoteTab }
  | { type: "open_stop_modal" }
  | { type: "close_stop_modal" };

export function createInitialMobileRemoteNavState(
  overrides: Partial<MobileRemoteNavState> = {}
): MobileRemoteNavState {
  return {
    screen: "welcome",
    sasPhrase: "",
    pendingConfig: null,
    requiresSas: false,
    selectedSessionId: null,
    activeTab: "sessions",
    stopModalOpen: false,
    ...overrides,
  };
}

export function reduceMobileRemoteNav(
  state: MobileRemoteNavState,
  action: MobileRemoteNavAction
): MobileRemoteNavState {
  switch (action.type) {
    case "open_qr_scan":
      return {
        ...state,
        screen: "qr_scan",
      };
    case "back_from_qr_scan":
    case "back_to_welcome":
      return {
        ...state,
        screen: "welcome",
        sasPhrase: "",
        pendingConfig: null,
        requiresSas: false,
      };
    case "accept_pairing":
      if (action.requiresSas) {
        return {
          ...state,
          screen: "sas",
          pendingConfig: action.config,
          requiresSas: true,
          sasPhrase: action.sasPhrase ?? "",
        };
      }
      return {
        ...state,
        screen: "connecting",
        pendingConfig: action.config,
        requiresSas: false,
        sasPhrase: "",
      };
    case "scan_qr_demo":
      return {
        ...state,
        screen: "sas",
        pendingConfig: null,
        requiresSas: true,
        sasPhrase: action.sasPhrase,
      };
    case "back_from_sas":
      return {
        ...state,
        screen: state.pendingConfig ? "qr_scan" : "welcome",
        sasPhrase: state.pendingConfig ? state.sasPhrase : "",
      };
    case "confirm_sas":
      return {
        ...state,
        screen: "connecting",
      };
    case "back_from_connecting":
      return {
        ...state,
        screen: state.pendingConfig ? "qr_scan" : "welcome",
        pendingConfig: null,
        requiresSas: false,
        sasPhrase: "",
      };
    case "connecting_complete":
      return {
        ...state,
        screen: "sessions",
        activeTab: "sessions",
        pendingConfig: null,
        requiresSas: false,
        sasPhrase: "",
      };
    case "select_session":
      return {
        ...state,
        screen: "chat",
        selectedSessionId: action.sessionId,
        stopModalOpen: false,
      };
    case "back_from_chat":
      return {
        ...state,
        screen: "sessions",
        selectedSessionId: null,
        stopModalOpen: false,
      };
    case "set_tab":
      return {
        ...state,
        activeTab: action.tab,
        stopModalOpen: false,
      };
    case "open_stop_modal":
      return {
        ...state,
        stopModalOpen: true,
      };
    case "close_stop_modal":
      return {
        ...state,
        stopModalOpen: false,
      };
    default:
      return state;
  }
}
