/**
 * ChatBubble Component
 *
 * Renders user and agent chat message events inside the Communication simulator.
 */
import { invoke } from "@tauri-apps/api/core";
import { useAtomValue } from "jotai";
import {
  Check,
  ChevronDown,
  ChevronRight,
  ClipboardCheck,
  Lock,
  Terminal,
  Toolbox,
  User,
} from "lucide-react";
import React, { memo, useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import type { AgentOrgRunMemberView } from "@src/api/tauri/agent";
import {
  CHAT_BUBBLE_WIDTH_TOKENS,
  ChatBubbleAvatar,
  ChatBubbleBody,
  ChatBubbleCopyButton,
  ChatBubbleHeader,
  ChatBubbleLayout,
} from "@src/components/ChatBubble";
import { ChatImageThumbnailRow } from "@src/components/ChatImageThumbnail";
import Markdown from "@src/components/MarkDown";
import { TerminalOutput } from "@src/components/TerminalDisplay";
import { PILL_REGEX, PILL_TYPES, type PillType } from "@src/config/pillTokens";
import UserMessageContent from "@src/engines/ChatPanel/ChatHistory/components/UserMessageContent";
import { stripExpandedPillContent } from "@src/engines/ChatPanel/InputArea/utils/pillContentParser";
import MessageReferenceCards from "@src/engines/ChatPanel/blocks/MessageReferenceCards";
import { SESSION_UI_TOKENS } from "@src/engines/ChatPanel/blocks/primitives/config";
import { extractTodoData } from "@src/engines/SessionCore/rendering/props";
import type { ExtractedTodoData } from "@src/engines/SessionCore/rendering/types/universalProps";
import { normalizeActivity } from "@src/lib/activityData";
import { installedSkillsAtom } from "@src/store/skills/installedSkillsAtom";
import type { InstalledSkill } from "@src/types/extensions";
import {
  formatSmartDateTime,
  toIntlLocaleTag,
} from "@src/util/data/formatters/date";

import {
  COMMUNICATION_AVATAR_ICON_SIZE,
  useCommunicationAgentIdentity,
} from "./communicationAgentIdentity";
import type { MessageEntry } from "./types";
import { computeUserBubbleLayout } from "./userBubbleLayout";

interface TerminalPillData {
  displayName: string;
  terminalText: string;
}

interface SkillPillData {
  displayName: string;
  /** Raw path token from the pill, e.g. "/create-skill" or "skill://create-skill" */
  rawPath: string;
  /** Resolved skill name (directory slug), derived from rawPath */
  skillName: string;
}

type CommunicationTodoItem = ExtractedTodoData["todos"][number];

const TERMINAL_PREVIEW_MAX_HEIGHT = 160;
const SKILL_PREVIEW_MAX_HEIGHT = 160;
const AVATAR_ICON_SIZE = COMMUNICATION_AVATAR_ICON_SIZE;
const PLAN_APPROVED_PREFIX = "[Plan approved";

const normalizeTodoStatus = (status: string): string =>
  (status || "").toLowerCase();

const isTodoCompleted = (status: string): boolean => {
  const statusNorm = normalizeTodoStatus(status);
  return statusNorm.includes("completed") || statusNorm === "completed";
};

const isTodoInProgress = (status: string): boolean =>
  normalizeTodoStatus(status) === "in_progress";

function renderCommunicationTodoLabel(todo: CommunicationTodoItem): string {
  if (
    isTodoInProgress(todo.status) &&
    todo.activeForm &&
    todo.activeForm.trim()
  ) {
    return todo.activeForm;
  }
  return todo.content;
}

function hasOpenCommunicationTodoBlockers(
  todo: CommunicationTodoItem,
  allTodos: CommunicationTodoItem[]
): boolean {
  if (!todo.blockedBy || todo.blockedBy.length === 0) return false;
  return todo.blockedBy.some((blockerIndex) => {
    const blocker = allTodos.find(
      (todoItem, index) =>
        index === blockerIndex || Number(todoItem.id) === blockerIndex
    );
    if (!blocker) return false;
    const statusNorm = normalizeTodoStatus(blocker.status);
    return statusNorm !== "completed" && statusNorm !== "cancelled";
  });
}

function communicationTodoRowKey(todoId: string, index: number): string {
  return `communication-todo:${todoId || "missing"}:${index}`;
}

const ReplayMarkdown: React.FC<{ content: string }> = memo(({ content }) => (
  <Markdown
    textContent={content}
    useChatCodeBlock={true}
    enableFileNavigation={true}
    skipPreprocess={false}
  />
));
ReplayMarkdown.displayName = "ReplayMarkdown";

const CommunicationTodoCheckbox: React.FC<{
  status: string;
  blocked?: boolean;
}> = ({ status, blocked }) => {
  if (isTodoCompleted(status)) {
    return (
      <div className="flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center rounded-full bg-green-600/80">
        <Check size={8} strokeWidth={3} className="text-white" />
      </div>
    );
  }
  if (blocked) {
    return (
      <div className="flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center rounded-full border-[1.5px] border-dashed border-text-3/40">
        <Lock size={6} strokeWidth={2.5} className="text-text-3/60" />
      </div>
    );
  }
  return (
    <div className="h-3.5 w-3.5 flex-shrink-0 rounded-full border-[1.5px] border-text-3/50" />
  );
};

const CommunicationTodoList: React.FC<{ todos: CommunicationTodoItem[] }> =
  memo(({ todos }) => {
    if (todos.length === 0) return null;

    return (
      <div className="rounded-lg border border-border-2 bg-transparent p-1">
        {todos.map((todo, index) => {
          const done = isTodoCompleted(todo.status);
          const inProgress = isTodoInProgress(todo.status);
          const blocked = hasOpenCommunicationTodoBlockers(todo, todos);
          return (
            <div
              key={communicationTodoRowKey(todo.id, index)}
              className={`group flex h-6 cursor-default items-center gap-1.5 rounded px-1.5 transition-colors hover:bg-fill-2 ${blocked ? "opacity-50" : ""}`}
            >
              <div className="flex shrink-0 items-center justify-center self-center">
                <CommunicationTodoCheckbox
                  status={todo.status}
                  blocked={blocked}
                />
              </div>
              <span
                className={`min-w-0 flex-1 truncate text-[13px] ${
                  done
                    ? "text-text-3 line-through"
                    : inProgress
                      ? "text-primary-6"
                      : "text-text-1"
                }`}
              >
                {renderCommunicationTodoLabel(todo)}
              </span>
              {blocked && todo.blockedBy && (
                <span className="ml-auto flex shrink-0 items-center gap-0.5 text-[10px] text-text-3/70">
                  <Lock size={8} strokeWidth={2} />
                  {todo.blockedBy
                    .map((blockerIndex) => `#${blockerIndex}`)
                    .join(", ")}
                </span>
              )}
            </div>
          );
        })}
      </div>
    );
  });
CommunicationTodoList.displayName = "CommunicationTodoList";

function extractCodeBlock(text: string): string | undefined {
  const match = text.match(/```\n?([\s\S]*?)```/);
  return match?.[1]?.trim() || undefined;
}

function parseTerminalPills(content: string): TerminalPillData[] {
  const terminalPills: TerminalPillData[] = [];
  const codeBlockContent = extractCodeBlock(content);

  for (const match of content.matchAll(PILL_REGEX)) {
    const pillType = match[2] as PillType;
    if (pillType !== "terminal" || !PILL_TYPES.has(pillType)) continue;

    const displayName = match[1].trim();
    const rawPath = match[3];
    let terminalText: string | undefined;

    if (rawPath.includes("::")) {
      const encoded = rawPath.slice(rawPath.indexOf("::") + 2);
      try {
        terminalText = decodeURIComponent(atob(encoded));
      } catch {
        terminalText = undefined;
      }
    }
    if (!terminalText && codeBlockContent) {
      terminalText = codeBlockContent;
    }
    if (terminalText) {
      terminalPills.push({ displayName, terminalText });
    }
  }

  return terminalPills;
}

function parseSkillPills(content: string): SkillPillData[] {
  const skillPills: SkillPillData[] = [];

  for (const match of content.matchAll(PILL_REGEX)) {
    const pillType = match[2] as PillType;
    if (pillType !== "skill" || !PILL_TYPES.has(pillType)) continue;

    const displayName = match[1].trim();
    const rawPath = match[3];
    // rawPath is like "/create-skill" or "skill://create-skill"
    const skillName = rawPath
      .replace(/^skill:\/\//, "")
      .replace(/^\//, "")
      .trim();
    if (skillName) {
      skillPills.push({ displayName, rawPath, skillName });
    }
  }

  return skillPills;
}

/**
 * Resolve a skill's actual file path from the installed skills list.
 * Falls back to constructing a likely path when not found.
 */
function resolveSkillFilePath(
  skillName: string,
  installedSkills: InstalledSkill[]
): string | undefined {
  const lower = skillName.toLowerCase();
  const found = installedSkills.find((s) => {
    if (s.name.toLowerCase() === lower) return true;
    const normalized = s.path.replace(/\\/g, "/");
    const segments = normalized.split("/");
    const dirName = segments[segments.length - 2];
    return dirName?.toLowerCase() === lower;
  });
  return found?.path;
}

const TerminalContextCard: React.FC<{ pill: TerminalPillData }> = memo(
  ({ pill }) => {
    const [isExpanded, setIsExpanded] = useState(true);
    const toggle = useCallback((event: React.MouseEvent) => {
      event.stopPropagation();
      setIsExpanded((prev) => !prev);
    }, []);

    return (
      <div className="overflow-hidden rounded-lg bg-fill-2 text-left">
        <button
          type="button"
          onClick={toggle}
          className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left"
        >
          <Terminal size={13} className="shrink-0 text-primary-6" />
          <span className="flex-1 truncate text-[12px] font-medium text-text-1">
            {pill.displayName}
          </span>
          {isExpanded ? (
            <ChevronDown size={11} className="shrink-0 text-text-3" />
          ) : (
            <ChevronRight size={11} className="shrink-0 text-text-3" />
          )}
        </button>
        {isExpanded && (
          <div
            className="relative rounded-b-lg bg-bg-3"
            style={{
              boxShadow:
                "inset 0 6px 8px -6px rgba(0,0,0,0.4), inset 0 -6px 8px -6px rgba(0,0,0,0.4)",
            }}
          >
            <TerminalOutput
              output={pill.terminalText}
              maxHeight={TERMINAL_PREVIEW_MAX_HEIGHT}
              showLoading={false}
              className="scrollbar-hide"
            />
          </div>
        )}
      </div>
    );
  }
);
TerminalContextCard.displayName = "TerminalContextCard";

const SkillContextCard: React.FC<{
  pill: SkillPillData;
  installedSkills: InstalledSkill[];
}> = memo(({ pill, installedSkills }) => {
  const [isExpanded, setIsExpanded] = useState(true);
  /** undefined = not yet fetched / loading, null = error/empty, string = content */
  const [content, setContent] = useState<string | undefined | null>(undefined);
  const fetchedRef = React.useRef(false);

  const filePath = useMemo(
    () => resolveSkillFilePath(pill.skillName, installedSkills),
    [pill.skillName, installedSkills]
  );

  useEffect(() => {
    if (!isExpanded || fetchedRef.current) return;
    fetchedRef.current = true;
    invoke<string>("skills_read", { workspacePath: null, name: pill.skillName })
      .then((text) => {
        setContent(text || null);
      })
      .catch(() => {
        setContent(null);
      });
  }, [isExpanded, pill.skillName]);

  const toggle = useCallback((event: React.MouseEvent) => {
    event.stopPropagation();
    setIsExpanded((prev) => !prev);
  }, []);

  const handleCardClick = useCallback(() => {
    const path = filePath;
    if (!path) return;
    document.dispatchEvent(
      new CustomEvent("file-pill-click", {
        detail: {
          filePath: path,
          fileName: pill.displayName,
          isFolder: false,
        },
      })
    );
  }, [filePath, pill.displayName]);

  return (
    <div className="overflow-hidden rounded-lg bg-fill-2 text-left">
      <button
        type="button"
        onClick={toggle}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left"
      >
        <Toolbox size={13} className="shrink-0 text-primary-6" />
        <span className="flex-1 truncate text-[12px] font-medium text-text-1">
          {pill.displayName}
        </span>
        {isExpanded ? (
          <ChevronDown size={11} className="shrink-0 text-text-3" />
        ) : (
          <ChevronRight size={11} className="shrink-0 text-text-3" />
        )}
      </button>
      {isExpanded && (
        <div
          role={filePath ? "button" : undefined}
          tabIndex={filePath ? 0 : undefined}
          onClick={filePath ? handleCardClick : undefined}
          onKeyDown={
            filePath
              ? (e) => {
                  if (e.key === "Enter" || e.key === " ") handleCardClick();
                }
              : undefined
          }
          className={`relative rounded-b-lg bg-bg-3 px-3 py-2 ${filePath ? "cursor-pointer" : ""}`}
          style={{
            maxHeight: SKILL_PREVIEW_MAX_HEIGHT,
            overflowY: "auto",
            boxShadow:
              "inset 0 6px 8px -6px rgba(0,0,0,0.4), inset 0 -6px 8px -6px rgba(0,0,0,0.4)",
          }}
        >
          {content === undefined && (
            <span className="text-[11px] text-text-3">Loading…</span>
          )}
          {content !== undefined && content !== null && (
            <div className="pointer-events-none text-[11px] leading-relaxed scrollbar-hide">
              <Markdown
                textContent={content}
                useChatCodeBlock={false}
                enableFileNavigation={false}
                skipPreprocess={false}
              />
            </div>
          )}
          {content === null && (
            <span className="text-[11px] text-text-3">
              No content available
            </span>
          )}
        </div>
      )}
    </div>
  );
});
SkillContextCard.displayName = "SkillContextCard";

const UserBubbleContent: React.FC<{
  content: string;
  images?: string[];
}> = memo(({ content, images }) => {
  const { t } = useTranslation("sessions");
  const terminalPills = useMemo(() => parseTerminalPills(content), [content]);
  const skillPills = useMemo(() => parseSkillPills(content), [content]);
  const installedSkills = useAtomValue(installedSkillsAtom);

  const isPlanApproved = content.startsWith(PLAN_APPROVED_PREFIX);
  const planApprovedEdited =
    isPlanApproved && content.startsWith("[Plan approved (edited)");

  // Strip terminal and skill pill tokens before passing to UserMessageContent.
  // Their cards render below; keeping the tokens would produce duplicate inline badges.
  // Also strip the auto-expanded pill content block appended by the Rust pill_resolver
  // (everything after "\n\n---\n**Referenced content (auto-expanded):**") so the raw
  // SKILL.md / file content doesn't leak into the inline text bubble.
  const strippedContent = useMemo(
    () =>
      stripExpandedPillContent(content)
        .replace(PILL_REGEX, (match, _name, pillType: string) =>
          pillType === "terminal" || pillType === "skill" ? "" : match
        )
        .trim(),
    [content]
  );

  const { hasImages, hasContent, showBubble, imageRowNeedsGap } =
    computeUserBubbleLayout(strippedContent, images);

  if (isPlanApproved) {
    return (
      <div className="flex flex-col items-start gap-1.5 text-left">
        <div
          className={`${CHAT_BUBBLE_WIDTH_TOKENS.userBody} group/replay-msg relative rounded-lg bg-primary-1 p-3 pr-10`}
        >
          <ChatBubbleCopyButton content={content} />
          <div className="flex items-center gap-2">
            <ClipboardCheck size={14} className="text-primary-6" />
            <span className="text-[13px] font-medium text-text-1">
              {planApprovedEdited
                ? t(
                    "chat.planApprovedEditedLabel",
                    "Implementing approved plan (edited)"
                  )
                : t("chat.planApprovedLabel", "Implementing approved plan")}
            </span>
          </div>
        </div>
      </div>
    );
  }

  if (
    !hasContent &&
    !hasImages &&
    terminalPills.length === 0 &&
    skillPills.length === 0
  )
    return null;

  return (
    <div className="flex flex-col items-start gap-1.5 text-left">
      {showBubble && (
        <div
          className={`${CHAT_BUBBLE_WIDTH_TOKENS.userBody} group/replay-msg relative rounded-lg bg-primary-1 p-3 ${hasContent ? "pr-10" : ""}`}
        >
          <ChatBubbleCopyButton content={strippedContent} />
          {hasImages && images && (
            <div className={imageRowNeedsGap ? "mb-2" : ""}>
              <ChatImageThumbnailRow images={images} />
            </div>
          )}
          {hasContent && <UserMessageContent text={strippedContent} />}
        </div>
      )}
      {terminalPills.map((pill, index) => (
        <TerminalContextCard key={`${pill.displayName}-${index}`} pill={pill} />
      ))}
      {skillPills.map((pill, index) => (
        <SkillContextCard
          key={`${pill.skillName}-${index}`}
          pill={pill}
          installedSkills={installedSkills}
        />
      ))}
    </div>
  );
});
UserBubbleContent.displayName = "UserBubbleContent";

type AgentFramedTitleKind = "generic" | "todo" | "plan" | "interaction";

interface AgentFramedBubbleProps {
  message: MessageEntry;
  onClick?: () => void;
  /** Skip bordered/padded body — for cards that bring their own container chrome. */
  unframed?: boolean;
  titleKind?: AgentFramedTitleKind;
  /**
   * Active org-run member roster. Used to resolve the bubble header
   * label from `event.sessionId` so multi-agent surfaces show the
   * subagent's real name (e.g. "Planner") instead of the generic
   * "Agent" fallback.
   */
  orgMembers?: ReadonlyArray<AgentOrgRunMemberView>;
  children: React.ReactNode;
}

const AgentFramedBubble: React.FC<AgentFramedBubbleProps> = ({
  message,
  onClick,
  unframed = false,
  titleKind = "generic",
  orgMembers,
  children,
}) => {
  const { t, i18n } = useTranslation(["common", "projects", "sessions"]);
  const { rawAgentName, agentIcon, isAgentOrgBubble } =
    useCommunicationAgentIdentity(message.event, orgMembers);
  const senderName = useMemo(() => {
    if (isAgentOrgBubble || titleKind === "generic") return rawAgentName;
    if (titleKind === "todo") {
      return t(
        "sessions:simulator.replay.messages.bubble.senderTitle.updatedTodos",
        {
          subject: rawAgentName,
        }
      );
    }
    if (titleKind === "plan") {
      return t(
        "sessions:simulator.replay.messages.bubble.senderTitle.updatedPlan",
        {
          subject: rawAgentName,
        }
      );
    }
    return t(
      "sessions:simulator.replay.messages.bubble.senderTitle.requestedInput",
      {
        subject: rawAgentName,
      }
    );
  }, [isAgentOrgBubble, rawAgentName, t, titleKind]);

  return (
    <ChatBubbleLayout
      align="left"
      onClick={onClick}
      interactive={false}
      className={CHAT_BUBBLE_WIDTH_TOKENS.row}
      avatar={
        <ChatBubbleAvatar className="h-8 w-8 bg-fill-2" icon={agentIcon} />
      }
    >
      <ChatBubbleHeader
        senderName={senderName}
        timestamp={formatSmartDateTime(message.timestamp, {
          yesterdayLabel: t("relativeDate.yesterday"),
          locale: toIntlLocaleTag(i18n.resolvedLanguage),
        })}
        align="left"
      />
      {unframed ? (
        children
      ) : (
        <ChatBubbleBody
          variant="agent"
          className="border border-border-2 bg-transparent px-3 py-2.5"
        >
          {children}
        </ChatBubbleBody>
      )}
    </ChatBubbleLayout>
  );
};

export const TodoBubble: React.FC<{
  message: MessageEntry;
  onClick?: () => void;
  orgMembers?: ReadonlyArray<AgentOrgRunMemberView>;
}> = memo(({ message, onClick, orgMembers }) => {
  const todos = useMemo(() => {
    const normalized = normalizeActivity(
      message.event as unknown as Record<string, unknown>
    );

    return extractTodoData({
      eventId: message.eventId,
      eventType: "manage_todo",
      args: normalized.args,
      result: normalized.result,
      status: "success",
      variant: "simulator",
      context: "simulator",
      rustExtracted: message.event.extracted,
    }).todos;
  }, [message.event, message.eventId]);

  return (
    <AgentFramedBubble
      message={message}
      onClick={onClick}
      unframed
      titleKind="todo"
      orgMembers={orgMembers}
    >
      <CommunicationTodoList todos={todos} />
    </AgentFramedBubble>
  );
});
TodoBubble.displayName = "TodoBubble";

export const InteractionBubble: React.FC<{
  message: MessageEntry;
  onClick?: () => void;
  orgMembers?: ReadonlyArray<AgentOrgRunMemberView>;
  children: React.ReactNode;
}> = memo(({ message, onClick, orgMembers, children }) => (
  <AgentFramedBubble
    message={message}
    onClick={onClick}
    unframed
    titleKind="interaction"
    orgMembers={orgMembers}
  >
    {children}
  </AgentFramedBubble>
));
InteractionBubble.displayName = "InteractionBubble";

export const PlanBubble: React.FC<{
  message: MessageEntry;
  onClick?: () => void;
  orgMembers?: ReadonlyArray<AgentOrgRunMemberView>;
  children: React.ReactNode;
}> = memo(({ message, onClick, orgMembers, children }) => (
  <AgentFramedBubble
    message={message}
    onClick={onClick}
    unframed
    titleKind="plan"
    orgMembers={orgMembers}
  >
    {children}
  </AgentFramedBubble>
));
PlanBubble.displayName = "PlanBubble";

export const ChatBubble: React.FC<{
  message: MessageEntry;
  index: number;
  isLatest?: boolean;
  onClick?: () => void;
  showChrome?: boolean;
  /**
   * Active org-run member roster. Used to resolve a subagent display
   * name (e.g. "Planner") from `event.sessionId` on multi-agent
   * surfaces. Falls back to the generic "Agent" label when omitted or
   * the session is not in the roster.
   */
  orgMembers?: ReadonlyArray<AgentOrgRunMemberView>;
}> = memo(
  ({
    message,
    index,
    isLatest = false,
    onClick,
    showChrome = true,
    orgMembers,
  }) => {
    const { t, i18n } = useTranslation(["common", "projects", "sessions"]);
    const isUser = message.sender === "user";
    const { rawAgentName, agentIcon } = useCommunicationAgentIdentity(
      message.event,
      orgMembers
    );
    const agentSenderName = rawAgentName;

    const rawContent =
      typeof message.content === "string"
        ? message.content
        : String(message.content ?? "");
    const userImages = useMemo<string[] | undefined>(() => {
      if (!isUser) return undefined;
      const result = message.event.result as { images?: unknown } | undefined;
      const raw = result?.images;
      if (Array.isArray(raw) && raw.length > 0) {
        return raw.filter((ref): ref is string => typeof ref === "string");
      }
      return undefined;
    }, [isUser, message.event.result]);
    const hasUserImages = !!userImages && userImages.length > 0;
    if (isUser && !rawContent.trim() && !hasUserImages) {
      return null;
    }

    return (
      <ChatBubbleLayout
        align="left"
        onClick={onClick}
        interactive={false}
        className={CHAT_BUBBLE_WIDTH_TOKENS.row}
        dataAttr={
          isUser
            ? { "data-replay-user-msg": index }
            : { "data-replay-agent-msg": index }
        }
        avatar={
          showChrome || isUser ? (
            <ChatBubbleAvatar
              className={`h-8 w-8 ${isUser ? "bg-primary-1" : "bg-fill-2"}`}
              icon={
                isUser ? (
                  <User size={AVATAR_ICON_SIZE} className="text-primary-6" />
                ) : (
                  agentIcon
                )
              }
            />
          ) : (
            <div className="h-8 w-8 shrink-0" aria-hidden="true" />
          )
        }
      >
        {showChrome && (
          <ChatBubbleHeader
            senderName={isUser ? t("terminology.you") : agentSenderName}
            timestamp={formatSmartDateTime(message.timestamp, {
              yesterdayLabel: t("relativeDate.yesterday"),
              locale: toIntlLocaleTag(i18n.resolvedLanguage),
            })}
            align="left"
          />
        )}
        {isUser ? (
          <UserBubbleContent content={rawContent} images={userImages} />
        ) : (
          <div
            className={`${CHAT_BUBBLE_WIDTH_TOKENS.body} group/replay-msg relative rounded-lg p-3 pr-10 text-left text-text-1 ${
              isLatest ? "bg-fill-2" : "bg-fill-1"
            }`}
          >
            <ChatBubbleCopyButton content={rawContent} />
            <div className={`min-w-0 ${SESSION_UI_TOKENS.TEXT.BODY_BASE}`}>
              <ReplayMarkdown content={message.content} />
              <MessageReferenceCards
                content={rawContent}
                enabled={message.event.displayStatus !== "running"}
                sessionId={message.event.sessionId}
              />
            </div>
          </div>
        )}
      </ChatBubbleLayout>
    );
  }
);
ChatBubble.displayName = "ChatBubble";
