/**
 * useTeamInboxMutePreferences
 *
 * Per-kind notification mute preferences, loaded lazily when the mute menu
 * opens. State is keyed to the data source so a source switch never shows
 * another scope's preferences; failures surface through the shared load
 * state only while the erroring source is still the active one.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  LoadState,
  TeamInboxDataSource,
  TeamInboxNotificationKind,
} from "./domain";

interface MutePreferencesState {
  dataSource: TeamInboxDataSource;
  kinds: TeamInboxNotificationKind[];
  loaded: boolean;
  loading: boolean;
}

export interface UseTeamInboxMutePreferencesOptions {
  dataSource: TeamInboxDataSource;
  t: (key: string) => string;
  setLoadState: (state: LoadState) => void;
}

export function useTeamInboxMutePreferences({
  dataSource,
  t,
  setLoadState,
}: UseTeamInboxMutePreferencesOptions) {
  const [mutePreferences, setMutePreferences] = useState<MutePreferencesState>(
    () => ({
      dataSource,
      kinds: [],
      loaded: false,
      loading: false,
    })
  );
  const mutePreferencesAreCurrent = mutePreferences.dataSource === dataSource;
  const mutedKinds = useMemo(
    () => (mutePreferencesAreCurrent ? mutePreferences.kinds : []),
    [mutePreferences.kinds, mutePreferencesAreCurrent]
  );
  const mutePreferencesLoaded =
    mutePreferencesAreCurrent && mutePreferences.loaded;
  const mutePreferencesLoading =
    mutePreferencesAreCurrent && mutePreferences.loading;
  const mountedRef = useRef(true);
  const activeDataSourceRef = useRef(dataSource);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    activeDataSourceRef.current = dataSource;
  }, [dataSource]);

  const handleLoadMutePreferences = useCallback(() => {
    if (
      mutePreferencesLoaded ||
      mutePreferencesLoading ||
      !dataSource.listMutedKinds
    ) {
      return;
    }
    setMutePreferences({
      dataSource,
      kinds: mutedKinds,
      loaded: mutePreferencesLoaded,
      loading: true,
    });
    void dataSource
      .listMutedKinds()
      .then((kinds) => {
        if (!mountedRef.current) return;
        setMutePreferences((current) =>
          current.dataSource === dataSource
            ? { ...current, kinds, loaded: true }
            : current
        );
      })
      .catch(() => {
        if (!mountedRef.current || dataSource !== activeDataSourceRef.current) {
          return;
        }
        setLoadState({
          status: "error",
          message: t("teamInbox.errors.mutePreferences"),
        });
      })
      .finally(() => {
        if (!mountedRef.current) return;
        setMutePreferences((current) =>
          current.dataSource === dataSource
            ? { ...current, loading: false }
            : current
        );
      });
  }, [
    dataSource,
    mutedKinds,
    mutePreferencesLoaded,
    mutePreferencesLoading,
    setLoadState,
    t,
  ]);

  const handleSetKindMuted = useCallback(
    (kind: TeamInboxNotificationKind, muted: boolean) => {
      if (!dataSource.setKindMuted || mutePreferencesLoading) return;
      setMutePreferences({
        dataSource,
        kinds: mutedKinds,
        loaded: mutePreferencesLoaded,
        loading: true,
      });
      void dataSource
        .setKindMuted(kind, muted)
        .then((kinds) => {
          if (!mountedRef.current) return;
          setMutePreferences((current) =>
            current.dataSource === dataSource
              ? { ...current, kinds, loaded: true }
              : current
          );
        })
        .catch(() => {
          if (
            !mountedRef.current ||
            dataSource !== activeDataSourceRef.current
          ) {
            return;
          }
          setLoadState({
            status: "error",
            message: t("teamInbox.errors.mutePreferences"),
          });
        })
        .finally(() => {
          if (!mountedRef.current) return;
          setMutePreferences((current) =>
            current.dataSource === dataSource
              ? { ...current, loading: false }
              : current
          );
        });
    },
    [
      dataSource,
      mutedKinds,
      mutePreferencesLoaded,
      mutePreferencesLoading,
      setLoadState,
      t,
    ]
  );

  return {
    mutedKinds,
    mutePreferencesLoading,
    handleLoadMutePreferences,
    handleSetKindMuted,
  };
}
