/**
 * useSyncGlobalTabs
 *
 * Syncs local context state with global tabs state.
 * Use this hook in your context providers to automatically track tabs globally.
 *
 * These hooks sync context-owned browser, editor, and document state to the
 * navigationSidebarTabsAtom for display in the GlobalTabsSidebar.
 *
 * PERFORMANCE: Each sync hook now uses focused hooks instead of the combined
 * useGlobalTabs hook, preventing unnecessary re-renders when other tab categories change.
 *
 * CRITICAL: Uses refs to prevent infinite loops. The sync is ONE-WAY:
 * local context state -> global tabs state
 */
import { useEffect, useRef } from "react";

import {
  useGlobalBrowserTabs,
  useGlobalDocumentTabs,
  useGlobalEditorTabs,
} from "./useGlobalTabs";

/**
 * Sync browser tabs to global state
 *
 * Used by: BrowserContext
 *
 * ONE-WAY sync: BrowserContext sessions -> navigationSidebarTabsAtom.browser
 * This hook should NOT cause re-renders when navigationSidebarTabsAtom changes.
 */
export const useSyncBrowserTabs = (
  sessions: Array<{
    id: string;
    title: string;
    url?: string;
    incognito?: boolean;
  }>,
  activeSessionId: string
) => {
  const {
    activeBrowser,
    addBrowserTab,
    setActiveBrowserTab,
    removeBrowserTab,
    updateBrowserTab,
  } = useGlobalBrowserTabs();

  // Track synced session IDs to detect additions/removals
  const syncedSessionIdsRef = useRef<Set<string>>(new Set());
  // Track synced session data to detect updates
  const syncedSessionDataRef = useRef<
    Map<string, { title: string; url?: string }>
  >(new Map());

  // Sync sessions to global state (one-way: local -> global)
  useEffect(() => {
    const currentSessionIds = new Set(sessions.map((session) => session.id));
    const syncedIds = syncedSessionIdsRef.current;
    const syncedData = syncedSessionDataRef.current;

    // Add new sessions
    sessions.forEach((session) => {
      if (!syncedIds.has(session.id)) {
        addBrowserTab({
          id: session.id,
          title: session.title,
          url: session.url,
          isActive: session.id === activeSessionId,
          isPrivate: session.incognito,
        });
        syncedIds.add(session.id);
        syncedData.set(session.id, { title: session.title, url: session.url });
      } else {
        // Check if we need to update existing tab
        const prevData = syncedData.get(session.id);
        if (
          prevData &&
          (prevData.title !== session.title || prevData.url !== session.url)
        ) {
          updateBrowserTab({
            id: session.id,
            title: session.title,
            url: session.url,
          });
          syncedData.set(session.id, {
            title: session.title,
            url: session.url,
          });
        }
      }
    });

    // Remove sessions that no longer exist
    syncedIds.forEach((id) => {
      if (!currentSessionIds.has(id)) {
        removeBrowserTab(id);
        syncedIds.delete(id);
        syncedData.delete(id);
      }
    });
  }, [
    sessions,
    activeSessionId,
    addBrowserTab,
    removeBrowserTab,
    updateBrowserTab,
  ]);

  // Sync active session (one-way: local -> global)
  // Use activeBrowser from hook instead of searching through browserTabs
  useEffect(() => {
    if (activeSessionId && activeBrowser?.id !== activeSessionId) {
      setActiveBrowserTab(activeSessionId);
    }
  }, [activeSessionId, activeBrowser?.id, setActiveBrowserTab]);
};

/**
 * Sync editor repos to global state
 *
 * Used by: EditorContext
 *
 * ONE-WAY sync: EditorContext repos -> navigationSidebarTabsAtom.editor
 */
export const useSyncEditorRepos = (
  repos: Array<{ id: string; name: string; description?: string }>,
  activeRepoId: string | null
) => {
  const { activeEditor, addEditorRepo, setActiveEditorRepo, removeEditorRepo } =
    useGlobalEditorTabs();

  // Track synced repo IDs to detect additions/removals
  const syncedRepoIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const currentRepoIds = new Set(repos.map((repo) => repo.id));
    const syncedIds = syncedRepoIdsRef.current;

    // Add new repos
    repos.forEach((repo) => {
      if (!syncedIds.has(repo.id)) {
        addEditorRepo({
          id: repo.id,
          name: repo.name,
          description: repo.description,
          isActive: repo.id === activeRepoId,
        });
        syncedIds.add(repo.id);
      }
    });

    // Remove repos that no longer exist
    syncedIds.forEach((id) => {
      if (!currentRepoIds.has(id)) {
        removeEditorRepo(id);
        syncedIds.delete(id);
      }
    });
  }, [repos, activeRepoId, addEditorRepo, removeEditorRepo]);

  useEffect(() => {
    if (activeRepoId && activeEditor !== activeRepoId) {
      setActiveEditorRepo(activeRepoId);
    }
  }, [activeRepoId, activeEditor, setActiveEditorRepo]);
};

/**
 * Sync document files to global state
 *
 * Used by: FilesContext
 *
 * ONE-WAY sync: FilesContext documents -> navigationSidebarTabsAtom.files
 */
export const useSyncDocumentFiles = (
  documents: Array<{ id: string; title: string; updatedAt?: string }>,
  activeDocumentId: string | null
) => {
  const {
    activeDocument,
    addDocumentFile,
    setActiveDocumentFile,
    removeDocumentFile,
  } = useGlobalDocumentTabs();

  // Track synced document IDs to detect additions/removals
  const syncedDocIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const currentDocIds = new Set(documents.map((doc) => doc.id));
    const syncedIds = syncedDocIdsRef.current;

    // Add new documents
    documents.forEach((doc) => {
      if (!syncedIds.has(doc.id)) {
        addDocumentFile({
          id: doc.id,
          title: doc.title,
          updatedAt: doc.updatedAt,
          isActive: doc.id === activeDocumentId,
        });
        syncedIds.add(doc.id);
      }
    });

    // Remove documents that no longer exist
    syncedIds.forEach((id) => {
      if (!currentDocIds.has(id)) {
        removeDocumentFile(id);
        syncedIds.delete(id);
      }
    });
  }, [documents, activeDocumentId, addDocumentFile, removeDocumentFile]);

  useEffect(() => {
    if (activeDocumentId && activeDocument?.id !== activeDocumentId) {
      setActiveDocumentFile(activeDocumentId);
    }
  }, [activeDocumentId, activeDocument?.id, setActiveDocumentFile]);
};
