import { Globe, KeyRound, Keyboard, ScanSearch } from "lucide-react";
import React, { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { STORY_SYNC_AUTH_METHOD } from "@src/api/http/integrations";
import { OAUTH_FLOW_KIND, type OAuthFlowStart } from "@src/api/http/project";
import {
  type DetectedGitHubCredentials,
  detectGitHubCredentials,
} from "@src/api/tauri/github";
import Button from "@src/components/Button";
import InlineAlert from "@src/components/InlineAlert";
import Input from "@src/components/Input";
import type { ChannelProbeResult } from "@src/modules/MainApp/Integrations/Connections/Channels/types";
import {
  SECTION_CONTROL_STYLE,
  SectionContainer,
  SectionRow,
} from "@src/modules/shared/layouts/SectionLayout";
import {
  SelectionGrid,
  type SelectionGridOption,
} from "@src/scaffold/WizardSystem/primitives";

import { CHANNEL_FORMS } from "./SetupForms";
import type { ProjectSyncAuthMethod } from "./channelWizardTypes";
import type { GitScanCandidate } from "./useChannelWizardState";

interface ChannelContentProps {
  selectedType: string | null;
  channelConfig: Record<string, unknown>;
  channelIsValid: boolean;
  probing: boolean;
  probeResult: ChannelProbeResult | null;
  probeErrorDismissed: boolean;
  onConfigChange: (updates: Record<string, unknown>) => void;
  onProbe: () => void;
  onDismissProbeError: () => void;
}

export const ChannelContent: React.FC<ChannelContentProps> = ({
  selectedType,
  channelConfig,
  channelIsValid,
  probing,
  probeResult,
  probeErrorDismissed,
  onConfigChange,
  onProbe,
  onDismissProbeError,
}) => {
  const { t } = useTranslation("integrations");
  const ChannelForm = selectedType ? CHANNEL_FORMS[selectedType] : null;

  if (!selectedType) return null;

  return (
    <>
      {ChannelForm && (
        <ChannelForm config={channelConfig} onChange={onConfigChange} />
      )}
      <SectionContainer>
        <SectionRow
          label={t("integrations.testConnection")}
          description={t("integrations.testConnectionDesc")}
          required
        >
          <Button
            variant={probeResult?.ok ? "success" : "primary"}
            appearance={probeResult?.ok ? "outline" : undefined}
            size="default"
            loading={probing}
            disabled={!channelIsValid || probing}
            onClick={onProbe}
            className="h-8 min-h-8"
          >
            {probeResult?.ok
              ? `✓ ${t("integrations.probeSuccess")}`
              : t("integrations.testConnection")}
          </Button>
        </SectionRow>
      </SectionContainer>
      {probeResult && !probeResult.ok && !probeErrorDismissed && (
        <div className="mt-3">
          <InlineAlert type="danger" onClose={onDismissProbeError}>
            {probeResult.error || t("integrations.probeFailed")}
          </InlineAlert>
        </div>
      )}
    </>
  );
};

interface ProjectContentProps {
  selectedType: string | null;
  isDuplicateName: boolean;
  projectAuthMethod: ProjectSyncAuthMethod;
  projectToken: string;
  projectSubmitting: boolean;
  projectSubmitError: string | null;
  projectOAuthFlow: OAuthFlowStart | null;
  onProjectMethodChange: (method: ProjectSyncAuthMethod) => void;
  onProjectTokenChange: (token: string) => void;
  onProjectSubmit: () => void;
}

export const ProjectContent: React.FC<ProjectContentProps> = ({
  selectedType,
  isDuplicateName,
  projectAuthMethod,
  projectToken,
  projectSubmitting,
  projectSubmitError,
  projectOAuthFlow,
  onProjectMethodChange,
  onProjectTokenChange,
  onProjectSubmit,
}) => {
  const { t } = useTranslation("integrations");
  const projectMethodOptions = useMemo<
    SelectionGridOption<ProjectSyncAuthMethod>[]
  >(
    () => [
      {
        key: STORY_SYNC_AUTH_METHOD.OAUTH,
        label: t("keyVault.guidedSetup"),
        icon: Globe,
      },
      {
        key: STORY_SYNC_AUTH_METHOD.PAT,
        label: t("keyVault.enterToken"),
        icon: Keyboard,
      },
    ],
    [t]
  );

  if (!selectedType) return null;

  return (
    <>
      <SectionContainer>
        <SectionRow
          label={t("keyVault.setupMethod")}
          description={t("keyVault.setupMethodDesc")}
          layout="vertical"
          required
        >
          <SelectionGrid
            options={projectMethodOptions}
            selected={projectAuthMethod}
            cardVariant="subtle"
            compactCards
            onSelect={onProjectMethodChange}
          />
        </SectionRow>
      </SectionContainer>

      {projectAuthMethod === STORY_SYNC_AUTH_METHOD.PAT && (
        <SectionContainer>
          <SectionRow
            label={t("projectConnections.personalAccessToken")}
            description={t("projectConnections.personalAccessTokenDesc")}
            required
          >
            <Input
              value={projectToken}
              onChange={onProjectTokenChange}
              placeholder={t(
                "projectConnections.personalAccessTokenPlaceholder"
              )}
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              style={SECTION_CONTROL_STYLE}
            />
          </SectionRow>
        </SectionContainer>
      )}

      {projectAuthMethod === STORY_SYNC_AUTH_METHOD.OAUTH && (
        <SectionContainer>
          <SectionRow
            label={
              projectOAuthFlow
                ? t("projectConnections.oauthWaiting")
                : t("keyVault.signIn")
            }
            description={
              projectOAuthFlow
                ? projectOAuthFlow.kind === OAUTH_FLOW_KIND.DEVICE
                  ? t("projectConnections.oauthDeviceDesc")
                  : t("projectConnections.oauthBrowserDesc")
                : t("keyVault.signInDesc")
            }
            required
          >
            {projectOAuthFlow ? (
              projectOAuthFlow.kind === OAUTH_FLOW_KIND.DEVICE ? (
                <div className="flex flex-col gap-2 text-[12px] text-text-2">
                  <Input
                    value={projectOAuthFlow.user_code}
                    readOnly
                    style={SECTION_CONTROL_STYLE}
                  />
                  <a
                    className="text-primary-6 hover:underline"
                    href={projectOAuthFlow.verification_uri}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {projectOAuthFlow.verification_uri}
                  </a>
                </div>
              ) : (
                <div className="text-[12px] text-text-2">
                  {t("projectConnections.oauthBrowserOpened")}
                </div>
              )
            ) : (
              <Button
                variant="primary"
                size="default"
                loading={projectSubmitting}
                disabled={isDuplicateName || projectSubmitting}
                onClick={onProjectSubmit}
                className="h-8 min-h-8"
              >
                {t("keyVault.signIn")}
              </Button>
            )}
          </SectionRow>
        </SectionContainer>
      )}

      {projectSubmitError && (
        <div className="mt-3">
          <InlineAlert type="danger">{projectSubmitError}</InlineAlert>
        </div>
      )}
    </>
  );
};

interface GitContentProps {
  selectedType: string | null;
  isDuplicateName: boolean;
  gitMethod: ProjectSyncAuthMethod | null;
  gitPat: string;
  gitSshKeyPath: string;
  gitScanCandidate: GitScanCandidate | null;
  gitOAuthFlow: OAuthFlowStart | null;
  gitSubmitting: boolean;
  gitSubmitError: string | null;
  onGitMethodChange: (method: ProjectSyncAuthMethod) => void;
  onGitPatChange: (token: string) => void;
  onGitSshKeyPathChange: (path: string) => void;
  onGitScanCandidateChange: (candidate: GitScanCandidate | null) => void;
  onGitOAuthStart: () => void;
}

export const GitContent: React.FC<GitContentProps> = ({
  selectedType,
  isDuplicateName,
  gitMethod,
  gitPat,
  gitSshKeyPath,
  gitScanCandidate,
  gitOAuthFlow,
  gitSubmitting,
  gitSubmitError,
  onGitMethodChange,
  onGitPatChange,
  onGitSshKeyPathChange,
  onGitScanCandidateChange,
  onGitOAuthStart,
}) => {
  const { t } = useTranslation("integrations");

  const methodOptions = useMemo<SelectionGridOption<ProjectSyncAuthMethod>[]>(
    () => [
      {
        key: STORY_SYNC_AUTH_METHOD.SCAN,
        label: t("gitConnections.methodScan", "Auto Detect"),
        icon: ScanSearch,
      },
      {
        key: STORY_SYNC_AUTH_METHOD.OAUTH,
        label: t("gitConnections.methodOAuth", "Sign in with GitHub"),
        icon: Globe,
      },
      {
        key: STORY_SYNC_AUTH_METHOD.PAT,
        label: "PAT",
        icon: Keyboard,
      },
      {
        key: STORY_SYNC_AUTH_METHOD.SSH,
        label: "SSH key",
        icon: KeyRound,
      },
    ],
    [t]
  );

  if (!selectedType) return null;

  return (
    <>
      <SectionContainer>
        <SectionRow
          label={t("keyVault.setupMethod")}
          description={t(
            "gitConnections.methodPickerDesc",
            "Pick how you want to authenticate to GitHub."
          )}
          layout="vertical"
          required
        >
          <SelectionGrid
            options={methodOptions}
            selected={gitMethod}
            cardVariant="subtle"
            compactCards
            onSelect={onGitMethodChange}
          />
        </SectionRow>
      </SectionContainer>

      {gitMethod === STORY_SYNC_AUTH_METHOD.SCAN && (
        <GitScanPanel
          isDuplicateName={isDuplicateName}
          selected={gitScanCandidate}
          onSelect={onGitScanCandidateChange}
        />
      )}

      {gitMethod === STORY_SYNC_AUTH_METHOD.OAUTH && (
        <SectionContainer>
          <SectionRow
            label={
              gitOAuthFlow
                ? t("projectConnections.oauthWaiting")
                : t("keyVault.signIn")
            }
            description={
              gitOAuthFlow
                ? gitOAuthFlow.kind === OAUTH_FLOW_KIND.DEVICE
                  ? t(
                      "gitConnections.oauthDeviceDesc",
                      "Open the verification URL and enter this code to authorize GitHub."
                    )
                  : t("projectConnections.oauthBrowserDesc")
                : t("keyVault.signInDesc")
            }
            required
          >
            {gitOAuthFlow ? (
              gitOAuthFlow.kind === OAUTH_FLOW_KIND.DEVICE ? (
                <div className="flex flex-col gap-2 text-[12px] text-text-2">
                  <Input
                    value={gitOAuthFlow.user_code}
                    readOnly
                    style={SECTION_CONTROL_STYLE}
                  />
                  <a
                    className="text-primary-6 hover:underline"
                    href={gitOAuthFlow.verification_uri}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {gitOAuthFlow.verification_uri}
                  </a>
                </div>
              ) : (
                <div className="text-[12px] text-text-2">
                  {t("projectConnections.oauthBrowserOpened")}
                </div>
              )
            ) : (
              <Button
                variant="primary"
                size="default"
                loading={gitSubmitting}
                disabled={isDuplicateName || gitSubmitting}
                onClick={onGitOAuthStart}
                className="h-8 min-h-8"
              >
                {t("keyVault.signIn")}
              </Button>
            )}
          </SectionRow>
        </SectionContainer>
      )}

      {gitMethod === STORY_SYNC_AUTH_METHOD.PAT && (
        <SectionContainer>
          <SectionRow
            label={t("projectConnections.personalAccessToken")}
            description={t("projectConnections.personalAccessTokenDesc")}
            required
          >
            <Input
              value={gitPat}
              onChange={onGitPatChange}
              placeholder={t(
                "projectConnections.personalAccessTokenPlaceholder"
              )}
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              style={SECTION_CONTROL_STYLE}
            />
          </SectionRow>
        </SectionContainer>
      )}

      {gitMethod === STORY_SYNC_AUTH_METHOD.SSH && (
        <GitSshPanel
          keyPath={gitSshKeyPath}
          onKeyPathChange={onGitSshKeyPathChange}
        />
      )}

      {gitSubmitError && (
        <div className="mt-3">
          <InlineAlert type="danger">{gitSubmitError}</InlineAlert>
        </div>
      )}
    </>
  );
};

// -- GitScanPanel ----------------------------------------------------
//
// Calls `detect_github_credentials` once on mount and renders the
// results as a tile list. Picking a tile stages a `GitScanCandidate`
// the wizard's submit handler dispatches on (token → createFromScan,
// SSH key → createFromSsh).

interface GitScanPanelProps {
  isDuplicateName: boolean;
  selected: GitScanCandidate | null;
  onSelect: (candidate: GitScanCandidate | null) => void;
}

const GitScanPanel: React.FC<GitScanPanelProps> = ({
  isDuplicateName,
  selected,
  onSelect,
}) => {
  const { t } = useTranslation("integrations");
  const [detected, setDetected] = useState<DetectedGitHubCredentials | null>(
    null
  );
  const [detecting, setDetecting] = useState(true);
  const [detectError, setDetectError] = useState<string | null>(null);

  useEffect(() => {
    // `detecting` / `detectError` start at their fresh-mount defaults
    // (true / null) so we don't reset them here — eslint flags
    // synchronous setState in an effect body as a cascading-render
    // smell. The effect just owns the async fetch + cleanup flag.
    let cancelled = false;
    detectGitHubCredentials()
      .then((result) => {
        if (cancelled) return;
        setDetected(result);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setDetectError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (cancelled) return;
        setDetecting(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const candidates = useMemo<GitScanCandidate[]>(() => {
    if (!detected) return [];
    const out: GitScanCandidate[] = [];
    if (detected.gh_cli) {
      out.push({
        kind: "gh_cli",
        label: t("gitConnections.scanGhCli", "GitHub CLI (gh)"),
        secret: detected.gh_cli.token,
        username: detected.gh_cli.username || undefined,
      });
    }
    if (detected.credential_helper?.token) {
      out.push({
        kind: "credential_helper",
        label: t(
          "gitConnections.scanCredHelper",
          "Git credential helper ({{name}})",
          { name: detected.credential_helper.helper }
        ),
        secret: detected.credential_helper.token,
        username: detected.credential_helper.username || undefined,
      });
    }
    // Public keys carry the `.pub` suffix; the private key (which is
    // what ssh actually uses) is the same filename minus `.pub`. We
    // pre-strip here so the candidate's `secret` field is the path
    // the SSH command will reference.
    for (const key of detected.ssh_keys) {
      const privateName = key.filename.endsWith(".pub")
        ? key.filename.slice(0, -4)
        : key.filename;
      out.push({
        kind: "ssh_key",
        label: t("gitConnections.scanSshKey", "SSH key — {{name}}", {
          name: privateName,
        }),
        secret: `~/.ssh/${privateName}`,
        username: key.comment || undefined,
      });
    }
    return out;
  }, [detected, t]);

  if (detecting) {
    return (
      <SectionContainer>
        <SectionRow
          label={t("gitConnections.scanning", "Scanning…")}
          layout="vertical"
        >
          <div className="text-[12px] text-text-2">
            {t(
              "gitConnections.scanningDesc",
              "Looking for gh CLI tokens, credential helpers, and SSH keys on this machine."
            )}
          </div>
        </SectionRow>
      </SectionContainer>
    );
  }

  if (detectError) {
    return <InlineAlert type="danger">{detectError}</InlineAlert>;
  }

  if (candidates.length === 0) {
    return (
      <SectionContainer>
        <SectionRow
          label={t("gitConnections.scanEmpty", "Nothing detected")}
          layout="vertical"
        >
          <div className="text-[12px] text-text-2">
            {t(
              "gitConnections.scanEmptyDesc",
              "No gh CLI tokens, credential helpers, or SSH keys were found. Pick another method above."
            )}
          </div>
        </SectionRow>
      </SectionContainer>
    );
  }

  return (
    <SectionContainer>
      <SectionRow
        label={t("gitConnections.scanResults", "Detected credentials")}
        description={t(
          "gitConnections.scanResultsDesc",
          "Pick one to import. We validate tokens against GitHub before saving."
        )}
        layout="vertical"
        required
      >
        <div className="flex flex-col gap-1.5">
          {candidates.map((candidate) => {
            const isSelected =
              !!selected &&
              selected.kind === candidate.kind &&
              selected.secret === candidate.secret;
            return (
              <button
                key={`${candidate.kind}:${candidate.secret}`}
                type="button"
                onClick={() => onSelect(isSelected ? null : candidate)}
                disabled={isDuplicateName}
                className={`flex items-center justify-between rounded-md border px-3 py-2 text-left text-[12px] transition-colors ${
                  isSelected
                    ? "border-primary-6 bg-primary-1 text-text-1"
                    : "border-border-2 text-text-2 hover:border-border-3"
                } disabled:cursor-not-allowed disabled:opacity-50`}
              >
                <span className="flex flex-col">
                  <span className="font-medium">{candidate.label}</span>
                  {candidate.username && (
                    <span className="text-text-3">{candidate.username}</span>
                  )}
                </span>
                {isSelected && <span className="text-primary-6">✓</span>}
              </button>
            );
          })}
        </div>
      </SectionRow>
    </SectionContainer>
  );
};

// -- GitSshPanel -----------------------------------------------------
//
// Plain text input for an SSH private key path. We don't attempt to
// validate the file here — the only honest validation is `ssh -T
// git@github.com`, which is slow, may prompt, and may mutate
// `known_hosts`. Consumers test the key implicitly on first clone.

interface GitSshPanelProps {
  keyPath: string;
  onKeyPathChange: (path: string) => void;
}

const GitSshPanel: React.FC<GitSshPanelProps> = ({
  keyPath,
  onKeyPathChange,
}) => {
  const { t } = useTranslation("integrations");
  return (
    <SectionContainer>
      <SectionRow
        label={t("gitConnections.sshKeyPath", "SSH key path")}
        description={t(
          "gitConnections.sshKeyPathDesc",
          "Absolute path to the private key (e.g. ~/.ssh/id_ed25519). The matching public key must already be registered on GitHub."
        )}
        required
      >
        <Input
          value={keyPath}
          onChange={onKeyPathChange}
          placeholder="~/.ssh/id_ed25519"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          style={SECTION_CONTROL_STYLE}
        />
      </SectionRow>
    </SectionContainer>
  );
};
