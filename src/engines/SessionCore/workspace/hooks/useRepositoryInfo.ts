/**
 * useRepositoryInfo Hook
 */
import { useAtomValue, useSetAtom } from "jotai";

import {
  isRepositoryLoadingAtom,
  repoPathAtom,
  repositoryIdAtom,
  repositoryNameAtom,
} from "../atoms/sessionAtoms";

/** Repository info only */
export function useRepositoryInfo() {
  const repositoryName = useAtomValue(repositoryNameAtom);
  const repositoryId = useAtomValue(repositoryIdAtom);
  const repoPath = useAtomValue(repoPathAtom);
  const isLoading = useAtomValue(isRepositoryLoadingAtom);
  const setRepositoryName = useSetAtom(repositoryNameAtom);
  const setRepositoryId = useSetAtom(repositoryIdAtom);
  const setRepoPath = useSetAtom(repoPathAtom);
  const setIsLoading = useSetAtom(isRepositoryLoadingAtom);

  return {
    repositoryName,
    setRepositoryName,
    repositoryId,
    setRepositoryId,
    repoPath,
    setRepoPath,
    isLoading,
    setIsLoading,
  };
}
