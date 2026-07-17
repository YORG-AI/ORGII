import React from "react";

import type { Repo } from "@src/store/repo/types";

import RepoActionButtons from "./RepoActionButtons";

interface LaunchpadActionStripProps {
  repo: Repo;
  onOpenDetails: (repo: Repo) => void;
  onClear: () => void;
}

const LaunchpadActionStrip: React.FC<LaunchpadActionStripProps> = ({
  repo,
  onOpenDetails,
  onClear,
}) => (
  <div className="w-full min-w-0 overflow-hidden rounded-full bg-fill-1 px-2 py-1.5">
    <RepoActionButtons
      repo={repo}
      onOpenDetails={onOpenDetails}
      onClear={onClear}
      shape="round"
      className="overflow-x-auto scrollbar-hide"
    />
  </div>
);

export default LaunchpadActionStrip;
