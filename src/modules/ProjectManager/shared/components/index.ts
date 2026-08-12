/**
 * Project Manager Shared Components
 *
 * Components shared between Projects and WorkItem modules.
 */
export { default as ClaimIdentityModal } from "./ClaimIdentityModal";
export type { ClaimIdentityModalProps } from "./ClaimIdentityModal";
export { default as DetailSplitLayout } from "./DetailSplitLayout";
export type { DetailSplitLayoutProps } from "./DetailSplitLayout";
export {
  CreateComposerHeader,
  CreateComposerPinnedActions,
  CreateComposerTitleInput,
  ManualCreateComposer,
} from "./CreateComposerScaffold";
export type {
  CreateComposerTitleInputProps,
  ManualCreateComposerProps,
  ManualCreateEditorRef,
} from "./CreateComposerScaffold";
export {
  default as ProjectContentEditor,
  ProjectContentTitleInput,
} from "./ProjectContentEditor";
export { default as ProjectOrganizationField } from "./ProjectOrganizationField";
export type { ProjectOrganizationFieldProps } from "./ProjectOrganizationField";
export { default as ProjectOrganizationSelect } from "./ProjectOrganizationSelect";
export type { ProjectOrganizationSelectProps } from "./ProjectOrganizationSelect";
export type {
  ProjectContentEditorRef,
  ProjectContentEditorProps,
  ProjectContentTitleInputProps,
} from "./ProjectContentEditor";
export { default as PropertiesPanel } from "./PropertiesPanel";
export { default as PropertiesRailFrame } from "./PropertiesPanel/PropertiesRailFrame";
export type { PropertiesPanelShellProps } from "./PropertiesPanel";
export type {
  LinkedRepoOption,
  ProjectData,
  PropertiesPanelProps,
} from "./PropertiesPanel";
export {
  default as ProjectPropertyFields,
  PROJECT_PROPERTY_CONCISE_FIELDS,
} from "./PropertiesPanel/ProjectPropertyFields";
export type { ProjectPropertyFieldsProps } from "./PropertiesPanel/ProjectPropertyFields";
export { default as VirtualizedGroupedList } from "./VirtualizedGroupedList";
export type { VirtualizedGroup } from "./VirtualizedGroupedList";
