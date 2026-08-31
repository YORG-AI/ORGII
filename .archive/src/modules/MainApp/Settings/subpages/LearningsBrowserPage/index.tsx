/**
 * LearningsBrowserPage — standalone full-page shell (e.g. dev / deep links).
 * Primary UI: Agent Teams → Integrations → Memory → Learnings tab.
 */
import React from "react";

import { LearningsBrowserContent } from "./LearningsBrowserContent";

interface LearningsBrowserPageProps {
  onClose?: () => void;
}

const LearningsBrowserPage: React.FC<LearningsBrowserPageProps> = ({
  onClose,
}) => <LearningsBrowserContent variant="settingsPage" onClose={onClose} />;

export default LearningsBrowserPage;
