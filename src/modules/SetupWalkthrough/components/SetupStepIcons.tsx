import workModelIcon from "@src/assets/fileTypeIcons/flow.svg";
import organizationIcon from "@src/assets/fileTypeIcons/folder-cluster.svg";
import tutorialIcon from "@src/assets/fileTypeIcons/folder-docs.svg";
import sharingIcon from "@src/assets/fileTypeIcons/folder-review.svg";
import goalIcon from "@src/assets/fileTypeIcons/folder-target.svg";
import themeIcon from "@src/assets/fileTypeIcons/folder-theme.svg";
import languageIcon from "@src/assets/fileTypeIcons/i18n.svg";
import toolsIcon from "@src/assets/fileTypeIcons/key.svg";
import appearanceIcon from "@src/assets/fileTypeIcons/moon.svg";
import readyIcon from "@src/assets/fileTypeIcons/rocket.svg";
import basicsIcon from "@src/assets/fileTypeIcons/settings.svg";
import { createRepositoryAssetIcon } from "@src/components/RepositoryAssetIcon";

export const GoalStepIcon = createRepositoryAssetIcon(goalIcon, "GoalStepIcon");
export const ToolsStepIcon = createRepositoryAssetIcon(
  toolsIcon,
  "ToolsStepIcon"
);
export const OrganizationStepIcon = createRepositoryAssetIcon(
  organizationIcon,
  "OrganizationStepIcon"
);
export const SharingStepIcon = createRepositoryAssetIcon(
  sharingIcon,
  "SharingStepIcon"
);
export const BasicsStepIcon = createRepositoryAssetIcon(
  basicsIcon,
  "BasicsStepIcon"
);
export const TutorialStepIcon = createRepositoryAssetIcon(
  tutorialIcon,
  "TutorialStepIcon"
);
export const WorkModelStepIcon = createRepositoryAssetIcon(
  workModelIcon,
  "WorkModelStepIcon"
);
export const ReadyStepIcon = createRepositoryAssetIcon(
  readyIcon,
  "ReadyStepIcon"
);
export const LanguagePreferenceIcon = createRepositoryAssetIcon(
  languageIcon,
  "LanguagePreferenceIcon"
);
export const AppearancePreferenceIcon = createRepositoryAssetIcon(
  appearanceIcon,
  "AppearancePreferenceIcon"
);
export const ThemePreferenceIcon = createRepositoryAssetIcon(
  themeIcon,
  "ThemePreferenceIcon"
);
