import { invoke } from "@tauri-apps/api/core";
import { useAtom } from "jotai";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import Input from "@src/components/Input";
import Message from "@src/components/Message";
import Select from "@src/components/Select";
import Switch from "@src/components/Switch";
import Textarea from "@src/components/Textarea";
import {
  Add01Icon,
  Copy01Icon,
  Delete02Icon,
  HugeiconsIcon,
  Refresh04Icon,
  Tick01Icon,
  UserCircleIcon,
} from "@src/icons";
import {
  SECTION_ACTION_GAP_CLASSES,
  SECTION_CONTROL_STYLE,
  SectionContainer,
  SectionRow,
  SectionSidebarItem,
  SectionSidebarList,
  SectionSidebarSplit,
} from "@src/modules/shared/layouts/SectionLayout";
import { confirmDestructiveAction } from "@src/util/dialogs/confirmDestructiveAction";

import {
  type GitGlobalProfile,
  type GitProfile,
  createGitProfile,
  fromGlobalProfile,
  gitProfilesAtom,
  parseGitProfile,
  profileMatchesGlobal,
  serializeGitProfile,
  toGlobalProfile,
} from "./gitProfiles";

interface GitProfilesTabProps {
  connectedEmails: string[];
}

const GitProfilesTab: React.FC<GitProfilesTabProps> = ({ connectedEmails }) => {
  const { t } = useTranslation("integrations");
  const { t: tCommon } = useTranslation("common");
  const [state, setState] = useAtom(gitProfilesAtom);
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(
    state.activeProfileId ?? state.profiles[0]?.id ?? null
  );
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState(false);
  const [showRawConfig, setShowRawConfig] = useState(false);
  const [rawConfig, setRawConfig] = useState("");
  const initializedRef = useRef(false);

  const selectedProfile = useMemo(
    () => state.profiles.find((profile) => profile.id === selectedProfileId),
    [selectedProfileId, state.profiles]
  );

  useEffect(() => {
    if (initializedRef.current) return;
    initializedRef.current = true;
    void invoke<GitGlobalProfile>("get_git_global_profile")
      .then((globalProfile) => {
        if (state.profiles.length === 0) {
          const imported = fromGlobalProfile(
            globalProfile,
            t("gitProfiles.defaultProfile")
          );
          setSelectedProfileId(imported.id);
          setState({
            profiles: [imported],
            activeProfileId:
              imported.name && imported.email ? imported.id : null,
          });
          return;
        }
        const active = state.profiles.find((profile) =>
          profileMatchesGlobal(profile, globalProfile)
        );
        setSelectedProfileId(
          active?.id ?? state.activeProfileId ?? state.profiles[0].id
        );
        setState({ ...state, activeProfileId: active?.id ?? null });
      })
      .catch((error) => {
        Message.error(
          error instanceof Error ? error.message : t("gitProfiles.loadFailed")
        );
      })
      .finally(() => setLoading(false));
  }, [setState, state, t]);

  useEffect(() => {
    if (selectedProfile) setRawConfig(serializeGitProfile(selectedProfile));
  }, [selectedProfile]);

  const updateSelectedProfile = useCallback(
    (patch: Partial<Omit<GitProfile, "id">>) => {
      if (!selectedProfileId) return;
      setState((current) => ({
        profiles: current.profiles.map((profile) =>
          profile.id === selectedProfileId ? { ...profile, ...patch } : profile
        ),
        activeProfileId:
          current.activeProfileId === selectedProfileId
            ? null
            : current.activeProfileId,
      }));
    },
    [selectedProfileId, setState]
  );

  const handleAdd = useCallback(() => {
    const profile = createGitProfile({
      label: t("gitProfiles.newProfile"),
      email: connectedEmails[0] ?? "",
    });
    setState((current) => ({
      ...current,
      profiles: [...current.profiles, profile],
    }));
    setSelectedProfileId(profile.id);
  }, [connectedEmails, setState, t]);

  const handleDuplicate = useCallback(() => {
    if (!selectedProfile) return;
    const duplicate = createGitProfile({
      ...selectedProfile,
      label: t("gitProfiles.copyName", { name: selectedProfile.label }),
    });
    setState((current) => ({
      ...current,
      profiles: [...current.profiles, duplicate],
    }));
    setSelectedProfileId(duplicate.id);
  }, [selectedProfile, setState, t]);

  const handleRefresh = useCallback(async () => {
    setLoading(true);
    try {
      const globalProfile = await invoke<GitGlobalProfile>(
        "get_git_global_profile"
      );
      const active = state.profiles.find((profile) =>
        profileMatchesGlobal(profile, globalProfile)
      );
      const refreshedProfileId = active?.id ?? selectedProfileId;
      setState((current) => ({
        profiles: current.profiles.map((profile) =>
          profile.id === refreshedProfileId
            ? {
                ...profile,
                name: globalProfile.name,
                email: globalProfile.email,
                signingKey: globalProfile.signing_key ?? "",
                signCommits: globalProfile.sign_commits,
              }
            : profile
        ),
        activeProfileId: refreshedProfileId,
      }));
      if (refreshedProfileId) setSelectedProfileId(refreshedProfileId);
      Message.success(t("gitProfiles.refreshed"));
    } catch (error) {
      Message.error(
        error instanceof Error ? error.message : t("gitProfiles.loadFailed")
      );
    } finally {
      setLoading(false);
    }
  }, [selectedProfileId, setState, state.profiles, t]);

  const handleDelete = useCallback(async () => {
    if (!selectedProfile || state.profiles.length === 1) return;
    const confirmed = await confirmDestructiveAction({
      title: t("gitProfiles.deleteTitle"),
      message: t("gitProfiles.deleteMessage", { name: selectedProfile.label }),
      okLabel: tCommon("actions.delete"),
      cancelLabel: tCommon("actions.cancel"),
    });
    if (!confirmed) return;
    const remaining = state.profiles.filter(
      (profile) => profile.id !== selectedProfile.id
    );
    setState({
      profiles: remaining,
      activeProfileId:
        state.activeProfileId === selectedProfile.id
          ? null
          : state.activeProfileId,
    });
    setSelectedProfileId(remaining[0]?.id ?? null);
  }, [selectedProfile, setState, state, t, tCommon]);

  const handleApply = useCallback(async () => {
    if (!selectedProfile) return;
    if (!selectedProfile.name.trim() || !selectedProfile.email.trim()) {
      Message.error(t("gitProfiles.nameEmailRequired"));
      return;
    }
    setApplying(true);
    try {
      await invoke("set_git_global_profile", {
        profile: toGlobalProfile(selectedProfile),
      });
      setState((current) => ({
        ...current,
        activeProfileId: selectedProfile.id,
      }));
      Message.success(
        t("gitProfiles.activated", { name: selectedProfile.label })
      );
    } catch (error) {
      Message.error(
        error instanceof Error ? error.message : t("gitProfiles.applyFailed")
      );
    } finally {
      setApplying(false);
    }
  }, [selectedProfile, setState, t]);

  const handleApplyRawConfig = useCallback(() => {
    if (!selectedProfile) return;
    try {
      const parsed = parseGitProfile(rawConfig, selectedProfile);
      updateSelectedProfile(parsed);
      Message.success(t("gitProfiles.rawUpdated"));
    } catch (error) {
      Message.error(
        error instanceof Error ? error.message : t("gitProfiles.rawInvalid")
      );
    }
  }, [rawConfig, selectedProfile, t, updateSelectedProfile]);

  const emailOptions = useMemo(() => {
    const emails = new Set(connectedEmails);
    state.profiles.forEach((profile) => {
      if (profile.email) emails.add(profile.email);
    });
    return [...emails].map((email) => ({ label: email, value: email }));
  }, [connectedEmails, state.profiles]);

  if (loading && state.profiles.length === 0) {
    return (
      <SectionContainer title={t("gitProfiles.title")}>
        <SectionRow label={t("gitProfiles.loading")} />
      </SectionContainer>
    );
  }

  return (
    <div data-testid="settings-git-profiles-tab">
      <SectionContainer className="p-0!">
        <SectionSidebarSplit
          sidebar={
            <SectionSidebarList>
              {state.profiles.map((profile) => {
                const active = state.activeProfileId === profile.id;
                const selected = selectedProfileId === profile.id;
                return (
                  <SectionSidebarItem
                    key={profile.id}
                    selected={selected}
                    leading={
                      <HugeiconsIcon
                        icon={UserCircleIcon}
                        data-icon="user-round"
                        size={16}
                      />
                    }
                    trailing={
                      active ? (
                        <HugeiconsIcon
                          icon={Tick01Icon}
                          data-icon="check"
                          size={15}
                          className="text-success-6"
                          aria-label={t("gitProfiles.active")}
                        />
                      ) : null
                    }
                    onClick={() => setSelectedProfileId(profile.id)}
                    data-testid={`settings-git-profile-${profile.id}`}
                  >
                    <span className="block truncate font-medium">
                      {profile.label}
                    </span>
                  </SectionSidebarItem>
                );
              })}
              <SectionSidebarItem
                leading={
                  <HugeiconsIcon icon={Add01Icon} data-icon="plus" size={14} />
                }
                onClick={handleAdd}
                data-testid="settings-git-profile-add"
              >
                {t("gitProfiles.add")}
              </SectionSidebarItem>
              <SectionSidebarItem
                leading={
                  <HugeiconsIcon
                    icon={Refresh04Icon}
                    data-icon="refresh-cw"
                    size={14}
                    className={loading ? "animate-spin" : undefined}
                  />
                }
                disabled={loading}
                onClick={() => void handleRefresh()}
                title={t("gitProfiles.refresh")}
                data-testid="settings-git-profile-refresh"
              >
                {t("gitProfiles.refresh")}
              </SectionSidebarItem>
            </SectionSidebarList>
          }
        >
          {selectedProfile ? (
            <>
              <SectionRow label={t("gitProfiles.profileName")} required>
                <Input
                  value={selectedProfile.label}
                  onChange={(label) => updateSelectedProfile({ label })}
                  style={SECTION_CONTROL_STYLE}
                  data-testid="settings-git-profile-label"
                />
              </SectionRow>
              <SectionRow label={t("gitProfiles.authorName")} required>
                <Input
                  value={selectedProfile.name}
                  onChange={(name) => updateSelectedProfile({ name })}
                  style={SECTION_CONTROL_STYLE}
                  data-testid="settings-git-profile-author-name"
                />
              </SectionRow>
              <SectionRow label={t("gitProfiles.email")} required>
                <Select
                  value={selectedProfile.email}
                  onChange={(email) =>
                    updateSelectedProfile({ email: String(email) })
                  }
                  options={emailOptions}
                  showSearch
                  placeholder={t("gitProfiles.selectEmail")}
                  style={SECTION_CONTROL_STYLE}
                  dataTestId="settings-git-profile-email"
                />
              </SectionRow>
              <SectionRow label={t("gitProfiles.signingKey")}>
                <Input
                  value={selectedProfile.signingKey}
                  onChange={(signingKey) =>
                    updateSelectedProfile({ signingKey })
                  }
                  placeholder={t("gitProfiles.signingKeyPlaceholder")}
                  style={SECTION_CONTROL_STYLE}
                />
              </SectionRow>
              <SectionRow label={t("gitProfiles.signCommits")}>
                <Switch
                  checked={selectedProfile.signCommits}
                  onCheckedChange={(signCommits) =>
                    updateSelectedProfile({ signCommits })
                  }
                />
              </SectionRow>
              <SectionRow showHeader={false}>
                <div className="flex w-full flex-wrap items-center justify-between gap-2">
                  <Button
                    variant="secondary"
                    size="small"
                    onClick={() => setShowRawConfig((visible) => !visible)}
                  >
                    {showRawConfig
                      ? t("gitProfiles.hideRaw")
                      : t("gitProfiles.editRaw")}
                  </Button>
                  <div className={SECTION_ACTION_GAP_CLASSES}>
                    <Button
                      size="small"
                      icon={
                        <HugeiconsIcon
                          icon={Copy01Icon}
                          data-icon="copy"
                          size={14}
                        />
                      }
                      onClick={handleDuplicate}
                    >
                      {tCommon("actions.duplicate")}
                    </Button>
                    {state.profiles.length > 1 && (
                      <Button
                        variant="secondary"
                        size="small"
                        icon={
                          <HugeiconsIcon
                            icon={Delete02Icon}
                            data-icon="trash-2"
                            size={14}
                            className="text-danger-6"
                          />
                        }
                        onClick={() => void handleDelete()}
                      >
                        {tCommon("actions.delete")}
                      </Button>
                    )}
                    <Button
                      variant="primary"
                      size="small"
                      loading={applying}
                      disabled={applying}
                      onClick={() => void handleApply()}
                      data-testid="settings-git-profile-activate"
                    >
                      {state.activeProfileId === selectedProfile.id
                        ? t("gitProfiles.active")
                        : t("gitProfiles.activate")}
                    </Button>
                  </div>
                </div>
              </SectionRow>
            </>
          ) : null}
        </SectionSidebarSplit>
      </SectionContainer>

      {showRawConfig && selectedProfile && (
        <SectionContainer title={t("gitProfiles.rawTitle")}>
          <SectionRow label={t("gitProfiles.rawConfig")} layout="vertical">
            <Textarea
              value={rawConfig}
              onChange={setRawConfig}
              rows={8}
              resize="vertical"
              textareaClassName="font-mono text-xs"
              data-testid="settings-git-profile-raw-config"
            />
          </SectionRow>
          <SectionRow showHeader={false}>
            <div className="flex w-full justify-end">
              <Button
                variant="primary"
                size="small"
                onClick={handleApplyRawConfig}
              >
                {t("gitProfiles.updateFromRaw")}
              </Button>
            </div>
          </SectionRow>
        </SectionContainer>
      )}
    </div>
  );
};

export default GitProfilesTab;
