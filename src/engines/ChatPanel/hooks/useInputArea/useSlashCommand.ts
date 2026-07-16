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
import type { AgentExecMode } from "@src/config/sessionCreatorConfig";
import { buildMcpToolCommand } from "@src/engines/ChatPanel/InputArea/components/SlashCommandPortal/slashItemUtils";
import { useSessionId } from "@src/engines/SessionCore/hooks/session/useSessionId";
import { useSessionExecModeField } from "@src/hooks/session/useSessionPatch";
import { creatorDefaultExecModeAtom } from "@src/store/session/creatorDefaultExecModeAtom";
import { SLASH_ACTIONS, type SlashItem } from "@src/types/extensions";

import { useSlashItemsCache } from "./useSlashItemsCache";

interface UseSlashCommandOptions {
  composerInputRef: RefObject<ComposerInputRef | null>;
  setShowSlashMenu: (show: boolean) => void;
  setSlashQuery: (query: string) => void;
  workspacePaths?: string[];
  /**
   * When `true`, `/mode` always reads + writes `creatorDefaultExecModeAtom`
   * even if there is an active session in the route. Set by callers that
   * mount the input outside an in-session context (e.g. the
   * `SessionCreator` tiptap, where the user is configuring a *new*
   * session and `activeSessionIdAtom` is still pointing at the previous
   * session they were on). Defaults to `false` (the InputArea case).
   */
  creatorDefaultMode?: boolean;
}

export interface SlashCommandHandlers {
  handleSlashCommand: (query: string) => void;
  handleSlashCommandClose: () => void;
  handleSlashSelect: (item: SlashItem) => void;
  handleSlashAppendSelect: (item: SlashItem) => void;
  handleModeSelect: (mode: AgentExecMode) => void;
  currentMode: AgentExecMode;
  filteredItems: SlashItem[];
  slashLoading: boolean;
  /**
   * Fetch and filter items without opening the inline slash menu.
   * Use this when the + button portal needs fresh data but the inline
   * "/" menu must stay closed.
   */
  prefetchItems: (query: string) => void;
}

export function useSlashCommand(
  options: UseSlashCommandOptions
): SlashCommandHandlers {
  const {
    composerInputRef,
    setShowSlashMenu,
    setSlashQuery,
    workspacePaths,
    creatorDefaultMode: forceCreatorDefault = false,
  } = options;

  // Mode source-of-truth follows the session: when the slash command is
  // typed inside a live chat the `/` mode picker reads + writes the
  // session row. The SessionCreator path explicitly opts out via
  // `creatorDefaultMode: true` because `useSessionId()` would otherwise
  // resolve to the previously-active session — which is NOT the
  // session being configured in the creator — and a `/mode` pick
  // there would silently rewrite the background session's pill.
  const { sessionId } = useSessionId();
  const isInSession = !forceCreatorDefault && Boolean(sessionId);
  const creatorDefaultMode = useAtomValue(creatorDefaultExecModeAtom);
  const setCreatorDefaultMode = useSetAtom(creatorDefaultExecModeAtom);
  const { agentExecMode: sessionMode, setMode: setSessionMode } =
    useSessionExecModeField(sessionId ?? "");
  const currentMode: AgentExecMode = isInSession
    ? ((sessionMode as AgentExecMode | undefined) ?? creatorDefaultMode)
    : creatorDefaultMode;
  const setMode = useCallback(
    (mode: AgentExecMode) => {
      if (isInSession) {
        void setSessionMode(mode);
      } else {
        setCreatorDefaultMode(mode);
      }
    },
    [isInSession, setSessionMode, setCreatorDefaultMode]
  );

  const queryRef = useRef("");

  const { t } = useTranslation("sessions");
  const builtinSlashItems = useMemo<SlashItem[]>(
    () => [
      {
        name: SLASH_ACTIONS.COMPACT,
        description: t("input.compactCommandDescription"),
        category: "action",
        source: "builtin",
        acceptsArgs: true,
      },
    ],
    [t]
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

  const handleSlashSelect = useCallback(
    (item: SlashItem) => {
      if (!composerInputRef.current) return;

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
    [composerInputRef, setShowSlashMenu, setSlashQuery]
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
    (mode: AgentExecMode) => {
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
    filteredItems,
    slashLoading,
    prefetchItems,
  };
}
