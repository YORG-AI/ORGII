/**
 * Files Context
 *
 * Provides files/documents state management across Files page and FilesExtraSidebar
 */
import React, { createContext, useContext, useMemo } from "react";

import {
  Document,
  DocumentMeta,
  useDocumentStorage,
} from "@src/hooks/files/useDocumentStorage";
import { useSyncDocumentFiles } from "@src/hooks/ui/tabs/useSyncGlobalTabs";

interface FilesContextValue {
  documents: DocumentMeta[];
  currentDocument: Document | null;
  isLoading: boolean;
  isSaving: boolean;
  filterValue: string;
  setFilterValue: (value: string) => void;
  createDocument: (title?: string) => Promise<Document>;
  loadDocument: (docId: string) => Promise<Document | null>;
  saveDocument: (doc: Document) => Promise<boolean>;
  autoSave: (doc: Document) => void;
  deleteDocument: (docId: string) => Promise<boolean>;
  renameDocument: (docId: string, newTitle: string) => Promise<boolean>;
}

const FilesContext = createContext<FilesContextValue | null>(null);

export const FilesProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  // Use the existing document storage hook
  const {
    documents,
    currentDocument,
    isLoading,
    isSaving,
    createDocument,
    loadDocument,
    saveDocument,
    autoSave,
    deleteDocument,
    renameDocument,
  } = useDocumentStorage();

  // Local filter state (not persisted)
  const [filterValue, setFilterValue] = React.useState<string>("");

  // ✨ Sync to global tabs state
  useSyncDocumentFiles(documents, currentDocument?.id || null);

  const value = useMemo<FilesContextValue>(
    () => ({
      documents,
      currentDocument,
      isLoading,
      isSaving,
      filterValue,
      setFilterValue,
      createDocument,
      loadDocument,
      saveDocument,
      autoSave,
      deleteDocument,
      renameDocument,
    }),
    [
      documents,
      currentDocument,
      isLoading,
      isSaving,
      filterValue,
      createDocument,
      loadDocument,
      saveDocument,
      autoSave,
      deleteDocument,
      renameDocument,
    ]
  );

  return (
    <FilesContext.Provider value={value}>{children}</FilesContext.Provider>
  );
};

export const useFilesContext = () => {
  const context = useContext(FilesContext);
  if (!context) {
    throw new Error("useFilesContext must be used within FilesProvider");
  }
  return context;
};

// Optional version that doesn't throw - for GlobalTabsSidebar
export const useFilesContextOptional = () => {
  return useContext(FilesContext);
};
