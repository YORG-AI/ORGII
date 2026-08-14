/**
 * useSlashCommand
 *
 * Handles / slash command dropdown logic for the InputArea.
 * When the user types "/" at position 0 in an empty input, shows available
 * built-in slash actions in a filterable dropdown.
 */
import { useAtomValue, useSetAtom } from "jotai";
import { type RefObject, useCallback, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";

import type { ComposerInputRef } from "@src/components/ComposerInput";
import {
  type AgentExecMode,
  type ComposerModeEntry,
  PRODUCT_MODE_PROJECT,
  execModeForComposerSelection,
  resolveSessionAgentExecMode,
} from "@src/config/sessionCreatorConfig";
import { buildMcpToolCommand } from "@src/engines/ChatPanel/InputArea/components/SlashCommandPortal/slashItemUtils";
import { buildAddressCommentsPillPath } from "@src/features/Org2Cloud/addressCommentsSlashToken";
import {
  ADDRESS_COMMENTS_SLASH_SOURCE,
  type AddressCommentsThreadOption,
  useAddressCommentsSlashCommand,
} from "@src/features/Org2Cloud/useAddressCommentsSlashCommand";
import {
  useSessionComposerModeFields,
  useSessionExecModeField,
} from "@src/hooks/session/useSessionPatch";
import { creatorDefaultExecModeAtom } from "@src/store/session/creatorDefaultExecModeAtom";
import { creatorDefaultProductModeAtom } from "@src/store/session/creatorDefaultProductModeAtom";
import { SLASH_ACTIONS, type SlashItem } from "@src/types/extensions";
import {
  isAgentSession,
  isCliSession,
} from "@src/util/session/sessionDispatch";

import { useSlashItemsCache } from "./useSlashItemsCache";

interface UseSlashCommandOptions {
  composerInputRef: RefObject<ComposerInputRef | null>;
  setShowSlashMenu: (show: boolean) => void;
  setSlashQuery: (query: string) => void;
  workspacePaths?: string[];
  /** The session already resolved by the owning InputArea. */
  sessionId?: string;
  /**
   * The session the user is VIEWING, even when the composer dispatches
   * elsewhere. The external-history fork composer mounts with
   * `sessionScope="none"` (sending forks into a new session), which
   * blanks `sessionId` — but Address Comments must still target the
   * viewed history's threads; its run path forks first by design.
   */
  addressSessionId?: string | null;
  /**
   * When `true`, `/mode` always reads + writes `creatorDefaultExecModeAtom`
   * even if there is an active session in the route. Set by callers that
   * mount the input outside an in-session context (e.g. the
   * `SessionCreator` composer, where the user is configuring a *new*
   * session and `activeSessionIdAtom` is still pointing at the previous
   * session they were on). Defaults to `false` (the InputArea case).
   */
  creatorDefaultMode?: boolean;
}

export interface AddressCommentsFlyoutData {
  threads: AddressCommentsThreadOption[];
  onConfirm: (selectedHeadIds: string[]) => void;
}

export interface SlashCommandHandlers {
  handleSlashCommand: (query: string) => void;
  handleSlashCommandClose: () => void;
  handleSlashSelect: (item: SlashItem) => void;
  handleSlashAppendSelect: (item: SlashItem) => void;
  handleModeSelect: (mode: ComposerModeEntry["id"]) => void;
  currentMode: ComposerModeEntry["id"];
  /** Whether the `/` mode picker should offer the Project product mode. */
  includeProjectMode: boolean;
  filteredItems: SlashItem[];
  slashLoading: boolean;
  /**
   * Fetch and filter items without opening the inline slash menu.
   * Use this when the + button portal needs fresh data but the inline
   * "/" menu must stay closed.
   */
  prefetchItems: (query: string) => void;
  addressCommentsFlyout?: AddressCommentsFlyoutData;
}

export function useSlashCommand(
  options: UseSlashCommandOptions
): SlashCommandHandlers {
  const {
    composerInputRef,
    setShowSlashMenu,
    setSlashQuery,
    workspacePaths,
    sessionId,
    addressSessionId,
    creatorDefaultMode: forceCreatorDefault = false,
  } = options;

  // Mode source-of-truth follows the session: when the slash command is
  // typed inside a live chat the `/` mode picker reads + writes the
  // session row. Reuse the owning InputArea's already-resolved session id:
  // resolving it again here without the InputArea's prop/session-scope can
  // point slash actions at a stale background session after panel changes.
  // The SessionCreator path explicitly opts out via `creatorDefaultMode`.
  const isInSession = !forceCreatorDefault && Boolean(sessionId);
  const creatorDefaultMode = useAtomValue(creatorDefaultExecModeAtom);
  const setCreatorDefaultMode = useSetAtom(creatorDefaultExecModeAtom);
  const creatorProductDefault = useAtomValue(creatorDefaultProductModeAtom);
  const setCreatorProductDefault = useSetAtom(creatorDefaultProductModeAtom);
  const { agentExecMode: sessionMode, setMode: setSessionMode } =
    useSessionExecModeField(sessionId ?? "");
  const { productMode, setComposerMode } = useSessionComposerModeFields(
    sessionId ?? ""
  );
  // §5.2: only agent and CLI sessions carry the product-mode axis; the
  // creator always offers it because those are the kinds it launches.
  const carriesProductMode = isInSession
    ? Boolean(
        sessionId && (isAgentSession(sessionId) || isCliSession(sessionId))
      )
    : true;
  const currentExecMode: AgentExecMode = isInSession
    ? resolveSessionAgentExecMode(sessionMode)
    : creatorDefaultMode;
  const currentMode: ComposerModeEntry["id"] = carriesProductMode
    ? isInSession
      ? productMode === PRODUCT_MODE_PROJECT
        ? PRODUCT_MODE_PROJECT
        : currentExecMode
      : creatorProductDefault === PRODUCT_MODE_PROJECT
        ? PRODUCT_MODE_PROJECT
        : currentExecMode
    : currentExecMode;
  const setMode = useCallback(
    (selected: ComposerModeEntry["id"]) => {
      const derivedExecMode = execModeForComposerSelection(selected);
      if (isInSession) {
        // Mirror ModePill's §5.2 dispatch: persist both axes atomically.
        // Swallow rejections — the patch hooks roll back optimistic
        // writes and rethrow, which would otherwise hit the boundary.
        if (carriesProductMode) {
          void setComposerMode(selected, derivedExecMode).catch(() => {});
        } else {
          void setSessionMode(derivedExecMode).catch(() => {});
        }
      } else {
        setCreatorDefaultMode(derivedExecMode);
        setCreatorProductDefault(
          selected === PRODUCT_MODE_PROJECT ? PRODUCT_MODE_PROJECT : null
        );
      }
    },
    [
      isInSession,
      carriesProductMode,
      setComposerMode,
      setSessionMode,
      setCreatorDefaultMode,
      setCreatorProductDefault,
    ]
  );

  const queryRef = useRef("");

  const { t } = useTranslation("sessions");
  const { t: tNav } = useTranslation("navigation");
  const addressComments = useAddressCommentsSlashCommand(
    isInSession ? sessionId : (addressSessionId ?? null)
  );
  const addressCommentsItem = addressComments.item;
  const builtinSlashItems = useMemo<SlashItem[]>(
    () => [
      {
        name: SLASH_ACTIONS.COMPACT,
        description: t("input.compactCommandDescription"),
        category: "action",
        source: "builtin",
        acceptsArgs: true,
      },
      ...(addressCommentsItem ? [addressCommentsItem] : []),
    ],
    [t, addressCommentsItem]
  );

  const {
    filteredItems,
    loading: slashLoading,
    prefetch,
  } = useSlashItemsCache({
    builtinItems: builtinSlashItems,
    workspacePaths,
  });

  const prefetchItems = useCallback(
    (query: string) => {
      queryRef.current = query;
      prefetch(query);
    },
    [prefetch]
  );

  const handleSlashCommand = useCallback(
    (query: string) => {
      queryRef.current = query;
      setSlashQuery(query);
      setShowSlashMenu(true);
      prefetch(query);
    },
    [setShowSlashMenu, setSlashQuery, prefetch]
  );

  const handleSlashCommandClose = useCallback(() => {
    setShowSlashMenu(false);
    setSlashQuery("");
    queryRef.current = "";
  }, [setShowSlashMenu, setSlashQuery]);

  const addressThreads = addressComments.threads;
  const insertAddressCommentsPill = useCallback(
    (selectedHeadIds: string[]) => {
      if (!composerInputRef.current) return;
      const count =
        selectedHeadIds.length > 0
          ? selectedHeadIds.length
          : addressThreads.length;
      composerInputRef.current.insertFilePill(
        buildAddressCommentsPillPath(selectedHeadIds),
        false,
        "skill",
        tNav("cloud.comments.addressPill", { count })
      );
      composerInputRef.current.focus();
      setShowSlashMenu(false);
      setSlashQuery("");
      queryRef.current = "";
    },
    [composerInputRef, addressThreads, tNav, setShowSlashMenu, setSlashQuery]
  );

  const addressCommentsFlyout = useMemo<AddressCommentsFlyoutData | undefined>(
    () =>
      addressComments.available && addressThreads.length > 0
        ? { threads: addressThreads, onConfirm: insertAddressCommentsPill }
        : undefined,
    [addressComments.available, addressThreads, insertAddressCommentsPill]
  );

  const handleSlashSelect = useCallback(
    (item: SlashItem) => {
      if (!composerInputRef.current) return;

      if (item.source === ADDRESS_COMMENTS_SLASH_SOURCE) {
        insertAddressCommentsPill([]);
        return;
      }

      if (item.category === "skill") {
        const skillToken = `/${item.skillName ?? item.name}`;
        composerInputRef.current.insertFilePill(
          skillToken,
          false,
          "skill",
          item.name
        );
        composerInputRef.current.focus();
        setShowSlashMenu(false);
        setSlashQuery("");
        queryRef.current = "";
        return;
      }

      if (item.category === "tool" && item.serverName) {
        composerInputRef.current.setContent(
          buildMcpToolCommand(item.serverName, item.name)
        );
        composerInputRef.current.focus();
        setShowSlashMenu(false);
        setSlashQuery("");
        queryRef.current = "";
        return;
      }

      // The compact command renders as a pill (like skills) so the token
      // reads as one unit with the focus text typed after it. The submit
      // interceptor recognizes both the pill serialization and plain
      // "/compact" text (parseCompactSlashCommand).
      if (item.category === "action" && item.name === SLASH_ACTIONS.COMPACT) {
        composerInputRef.current.insertFilePill(
          `/${SLASH_ACTIONS.COMPACT}`,
          false,
          "skill",
          SLASH_ACTIONS.COMPACT
        );
        composerInputRef.current.focus();
        setShowSlashMenu(false);
        setSlashQuery("");
        queryRef.current = "";
        return;
      }

      composerInputRef.current.setContent(`/${item.name} `);
      composerInputRef.current.focus();

      setShowSlashMenu(false);
      setSlashQuery("");
      queryRef.current = "";
    },
    [
      composerInputRef,
      setShowSlashMenu,
      setSlashQuery,
      insertAddressCommentsPill,
    ]
  );

  const handleSlashAppendSelect = useCallback(
    (item: SlashItem) => {
      if (!composerInputRef.current) return;

      if (item.category === "skill") {
        const skillToken = `/${item.skillName ?? item.name}`;
        composerInputRef.current.appendFilePill(
          skillToken,
          false,
          "skill",
          item.name
        );
        composerInputRef.current.focus();
        setShowSlashMenu(false);
        setSlashQuery("");
        queryRef.current = "";
        return;
      }

      handleSlashSelect(item);
    },
    [composerInputRef, handleSlashSelect, setShowSlashMenu, setSlashQuery]
  );

  const handleModeSelect = useCallback(
    (mode: ComposerModeEntry["id"]) => {
      setMode(mode);
      setShowSlashMenu(false);
      setSlashQuery("");
      queryRef.current = "";
      if (composerInputRef.current) {
        composerInputRef.current.consumeSlashQuery();
      }
    },
    [setMode, setShowSlashMenu, setSlashQuery, composerInputRef]
  );

  return {
    handleSlashCommand,
    handleSlashCommandClose,
    handleSlashSelect,
    handleSlashAppendSelect,
    handleModeSelect,
    currentMode,
    includeProjectMode: carriesProductMode,
    filteredItems,
    slashLoading,
    prefetchItems,
    addressCommentsFlyout,
  };
}
