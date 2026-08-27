import {
  IMPORTED_HISTORY_SOURCE_DESCRIPTORS,
  type ImportedClientOrigin,
  type ImportedHistorySourceDescriptor,
} from "@src/api/tauri/externalHistory/imported/descriptors";
import { CLI_AGENT, type CliAgentType } from "@src/api/types/keys";
import { formatAgentType } from "@src/assets/providers";
import {
  THEMEABLE_ICONS,
  getIconProviderFromModelName,
  getIconProviderFromType,
} from "@src/components/ModelIcon/config";
import type { RemoteTeammateSessionMetadata } from "@src/store/collaboration/types";
import type { Session } from "@src/store/session/sessionAtom/types";

import { isAgentSession, resolveSessionIconId } from "./sessionDispatch";

const CLI_AGENT_TYPES = new Set<string>(Object.values(CLI_AGENT));
const ORGII_RUST_AGENT_DEFINITION_PREFIX = "builtin:";
const ORG2_AGENT_LABEL = "ORG2";

type ImportedSessionDisplayInput = Partial<
  Pick<
    NonNullable<Session["importedFrom"]>,
    "sourceSessionId" | "externalHistorySource" | "sourceDisplay"
  >
>;

export interface LocalSessionDisplayInput {
  session_id: string;
  user_input?: string;
  cliAgentType?: Session["cliAgentType"];
  agentOrgId?: string;
  agentDisplayName?: string;
  agentDefinitionId?: string;
  agentIconId?: string;
  model?: string;
  importedFrom?:
    | NonNullable<Session["importedFrom"]>
    | ImportedSessionDisplayInput;
  clientOrigin?: Session["clientOrigin"];
}

type RemoteSessionDisplayInput = Pick<
  RemoteTeammateSessionMetadata,
  | "sourceSessionId"
  | "cliAgentType"
  | "agentDisplayName"
  | "agentDefinitionId"
  | "model"
  | "origin"
>;

export type SessionDisplayMetadataSource =
  | { kind: "local"; session: LocalSessionDisplayInput }
  | { kind: "remote"; session: RemoteSessionDisplayInput };

export interface SessionDisplayMetadata {
  agentLabel: string;
  agentIconId: string;
  /** Raw source value for presentation, including older wire aliases. */
  agentType?: string;
  /** Validated local CLI type for filters and runnable configuration. */
  cliAgentType?: CliAgentType;
  modelName?: string;
  externalSource?: ImportedHistorySourceDescriptor;
  /**
   * Which client produced an imported session. Every surface that badges
   * provenance (sidebar rows, hover cards, the chat header) reads this one
   * resolved value rather than the raw session field, so the four-way
   * taxonomy stays defined in exactly one place.
   *
   * `org2` is returned as-is; suppressing its badge is a rendering decision
   * owned by the badge component, not a hole in this projection.
   */
  clientOrigin?: ImportedClientOrigin;
  /** Whether the resolved provider mark should inherit the row text color. */
  isMonochromeBrandIcon: boolean;
}

interface NormalizedSessionDisplayInput {
  kind: SessionDisplayMetadataSource["kind"];
  sessionId: string;
  cliAgentType?: string;
  agentDisplayName?: string;
  agentDefinitionId?: string;
  agentIconId?: string;
  modelName?: string;
  externalHistorySource?: string;
  imported: boolean;
  agentOrg: boolean;
  remoteNative: boolean;
  clientOrigin?: ImportedClientOrigin;
}

function normalizeSessionDisplayInput(
  source: SessionDisplayMetadataSource
): NormalizedSessionDisplayInput {
  if (source.kind === "remote") {
    const { session } = source;
    return {
      kind: source.kind,
      sessionId: session.sourceSessionId,
      cliAgentType: session.cliAgentType,
      agentDisplayName: session.agentDisplayName,
      agentDefinitionId: session.agentDefinitionId,
      modelName: session.model,
      externalHistorySource:
        session.origin?.kind === "external_history"
          ? session.origin.source
          : undefined,
      imported: false,
      agentOrg: false,
      remoteNative: !session.origin || session.origin.kind === "orgii",
      // Remote rows are replayed through the cloud, which does not carry the
      // source transcript's client provenance. Absent rather than guessed.
      clientOrigin: undefined,
    };
  }

  const { session } = source;
  const sourceDisplay = session.importedFrom?.sourceDisplay;
  return {
    kind: source.kind,
    sessionId: session.importedFrom?.sourceSessionId ?? session.session_id,
    cliAgentType: sourceDisplay?.cliAgentType ?? session.cliAgentType,
    agentDisplayName:
      sourceDisplay?.agentDisplayName ?? session.agentDisplayName,
    agentDefinitionId:
      sourceDisplay?.agentDefinitionId ?? session.agentDefinitionId,
    agentIconId: session.agentIconId,
    modelName: sourceDisplay?.model ?? session.model,
    externalHistorySource: session.importedFrom?.externalHistorySource,
    imported: Boolean(session.importedFrom),
    agentOrg: Boolean(session.agentOrgId),
    remoteNative: false,
    clientOrigin: session.clientOrigin,
  };
}

function parseCliAgentType(
  value: string | undefined
): CliAgentType | undefined {
  return value && CLI_AGENT_TYPES.has(value)
    ? (value as CliAgentType)
    : undefined;
}

function resolveExternalSource(
  explicitSource: string | undefined,
  sessionId: string
): ImportedHistorySourceDescriptor | undefined {
  return IMPORTED_HISTORY_SOURCE_DESCRIPTORS.find(
    (candidate) =>
      candidate.sourceId === explicitSource ||
      sessionId.startsWith(candidate.prefix)
  );
}

/** Brand mark named by a model id (`claude-sonnet-5` → the Claude mark). */
function resolveModelBrandIconId(
  modelName: string | undefined
): string | undefined {
  if (!modelName) return undefined;
  const provider = getIconProviderFromModelName(modelName);
  return provider === "unknown" ? undefined : provider;
}

function resolveAgentIconId(
  input: NormalizedSessionDisplayInput,
  agentType: string | undefined,
  externalSource: ImportedHistorySourceDescriptor | undefined
): string {
  if (input.agentOrg) return "network";
  if (externalSource) return externalSource.iconId;

  if (agentType) {
    let provider = getIconProviderFromType(agentType);
    // Older collaboration rows can carry display aliases such as
    // `claude_code_cli`; tolerate those without treating them as a runnable
    // local CliAgentType.
    if (provider === "unknown" && agentType.endsWith("_cli")) {
      provider = getIconProviderFromType(agentType.slice(0, -4));
    }
    if (provider !== "unknown") return provider;
  }

  if (input.agentDefinitionId?.startsWith(ORGII_RUST_AGENT_DEFINITION_PREFIX)) {
    return "orgii";
  }

  // ORG2-native sessions publish no `cliAgentType` — the Rust session
  // categories store it as NULL — so a shared Claude or GPT session arrives
  // with no agent identity at all and used to land on the generic ORG2 glyph.
  // Its model names the provider actually behind the run, which is the mark
  // the viewer recognizes. Only the ICON follows the model: `agentLabel` (and
  // with it the Agent filter) keeps naming the runtime.
  const modelBrandIconId = resolveModelBrandIconId(input.modelName);

  // Imported native ORGII replays used to carry `agentIconId: "archive"`,
  // which is not a registered agent icon and therefore fell through to Bot.
  if (input.imported || input.remoteNative) return modelBrandIconId ?? "orgii";

  return (
    input.agentIconId ||
    modelBrandIconId ||
    resolveSessionIconId(input.sessionId)
  );
}

function resolveCliAgentLabel(
  kind: SessionDisplayMetadataSource["kind"],
  agentType: string | undefined
): string | undefined {
  if (!agentType) return undefined;
  if (kind === "local" && agentType === CLI_AGENT.CLAUDE_CODE) {
    return "Claude CLI";
  }
  return formatAgentType(agentType);
}

function resolveAgentLabel(
  input: NormalizedSessionDisplayInput,
  agentType: string | undefined,
  externalSource: ImportedHistorySourceDescriptor | undefined
): string {
  if (externalSource) return externalSource.displayName;

  // ORG2-native Rust sessions may carry a specific definition name such as
  // "Agent Architect", but the Agent column identifies the runtime/provider,
  // not the selected definition. Keep that label stable before and after a
  // collaboration replay is opened.
  if (
    !agentType &&
    (input.remoteNative ||
      input.imported ||
      Boolean(input.agentDefinitionId) ||
      isAgentSession(input.sessionId))
  ) {
    return ORG2_AGENT_LABEL;
  }

  return (
    input.agentDisplayName ||
    resolveCliAgentLabel(input.kind, agentType) ||
    "Agent"
  );
}

/**
 * Canonical display projection for local sessions, imported replay copies,
 * and live cloud rows. It resolves presentation only; runtime/fork execution
 * continues to read the Session's own model and account fields.
 */
export function resolveSessionDisplayMetadata(
  source: SessionDisplayMetadataSource
): SessionDisplayMetadata {
  const input = normalizeSessionDisplayInput(source);
  const agentType = input.cliAgentType;
  const cliAgentType = parseCliAgentType(agentType);
  const externalSource = resolveExternalSource(
    input.externalHistorySource,
    input.sessionId
  );
  const agentIconId = resolveAgentIconId(input, agentType, externalSource);
  const iconProvider = getIconProviderFromType(agentIconId);

  return {
    agentLabel: resolveAgentLabel(input, agentType, externalSource),
    agentIconId,
    agentType,
    cliAgentType,
    modelName: input.modelName,
    externalSource,
    clientOrigin: input.clientOrigin,
    isMonochromeBrandIcon:
      iconProvider !== "unknown" && THEMEABLE_ICONS.has(iconProvider),
  };
}
