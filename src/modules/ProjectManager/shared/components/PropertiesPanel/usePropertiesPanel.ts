import {
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import { HEALTH_OPTIONS, PRIORITY_OPTIONS, STATUS_OPTIONS } from "./config";
import type {
  Label,
  LinkedRepoOption,
  Person,
  PickerType,
  ProjectData,
  ProjectHealth,
  ProjectPriority,
  ProjectStatus,
  Team,
} from "./types";

interface UsePropertiesPanelOptions {
  project: ProjectData;
  onUpdate?: (updates: Partial<ProjectData>) => void;
  /** External container ref for click-outside detection (from PropertiesPanel shell) */
  containerRef?: RefObject<HTMLElement | null>;
}

export function usePropertiesPanel({
  project,
  onUpdate,
  containerRef: externalRef,
}: UsePropertiesPanelOptions) {
  const { t } = useTranslation("projects");
  const [openPicker, setOpenPicker] = useState<PickerType>(null);
  const internalRef = useRef<HTMLElement>(null);
  const containerRef = externalRef ?? internalRef;

  // Track which project the picker was opened for — auto-close on project change
  const [pickerProjectId, setPickerProjectId] = useState(project.id);
  if (pickerProjectId !== project.id) {
    setPickerProjectId(project.id);
    if (openPicker !== null) setOpenPicker(null);
  }

  const togglePicker = useCallback((picker: PickerType) => {
    setOpenPicker((current) => (current === picker ? null : picker));
  }, []);

  const closePicker = useCallback(() => setOpenPicker(null), []);

  // Click-outside and ESC to close picker (consistent with useDropdownEngine)
  useEffect(() => {
    if (openPicker === null) return;

    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      if (target.closest("[data-field-row]")) return;
      // Match any open property dropdown in the document — containerRef is
      // optional and may be unset (CreateProjectView), and portal dropdowns
      // render outside the container. Must run before the option click fires.
      if (target.closest("[data-property-dropdown]")) return;
      closePicker();
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closePicker();
    };

    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [openPicker, closePicker]);

  // Derived current values
  const currentStatus = STATUS_OPTIONS.find(
    (opt) => opt.value === project.status
  );
  const currentPriority = PRIORITY_OPTIONS.find(
    (opt) => opt.value === project.priority
  );
  const currentHealth = HEALTH_OPTIONS.find(
    (opt) => opt.value === project.health
  );

  // Handlers
  const handleStatusChange = useCallback(
    (value: ProjectStatus) => {
      onUpdate?.({ status: value });
      setOpenPicker(null);
    },
    [onUpdate]
  );

  const handlePriorityChange = useCallback(
    (value: ProjectPriority) => {
      onUpdate?.({ priority: value });
      setOpenPicker(null);
    },
    [onUpdate]
  );

  const handleHealthChange = useCallback(
    (value: ProjectHealth) => {
      onUpdate?.({ health: value });
      setOpenPicker(null);
    },
    [onUpdate]
  );

  const handleLeadChange = useCallback(
    (person: Person | undefined) => {
      onUpdate?.({ lead: person });
      setOpenPicker(null);
    },
    [onUpdate]
  );

  const handleMemberToggle = useCallback(
    (person: Person) => {
      const currentMembers = project.members || [];
      const exists = currentMembers.some((item) => item.id === person.id);
      if (exists) {
        onUpdate?.({
          members: currentMembers.filter((item) => item.id !== person.id),
        });
      } else {
        onUpdate?.({ members: [...currentMembers, person] });
      }
    },
    [project.members, onUpdate]
  );

  const handleTeamToggle = useCallback(
    (team: Team) => {
      const currentTeams = project.teams || [];
      const exists = currentTeams.some((item) => item.id === team.id);
      if (exists) {
        onUpdate?.({
          teams: currentTeams.filter((item) => item.id !== team.id),
        });
      } else {
        onUpdate?.({ teams: [...currentTeams, team] });
      }
    },
    [project.teams, onUpdate]
  );

  const handleLabelToggle = useCallback(
    (label: Label) => {
      const currentLabels = project.labels || [];
      const exists = currentLabels.some((item) => item.id === label.id);
      if (exists) {
        onUpdate?.({
          labels: currentLabels.filter((item) => item.id !== label.id),
        });
      } else {
        onUpdate?.({ labels: [...currentLabels, label] });
      }
    },
    [project.labels, onUpdate]
  );

  const handleLinkedRepoToggle = useCallback(
    (repo: LinkedRepoOption) => {
      const currentRepos = project.linkedRepos || [];
      const exists = currentRepos.some((item) => item.id === repo.id);
      if (exists) {
        onUpdate?.({
          linkedRepos: currentRepos.filter((item) => item.id !== repo.id),
        });
      } else {
        onUpdate?.({ linkedRepos: [...currentRepos, repo] });
      }
    },
    [project.linkedRepos, onUpdate]
  );

  const handleWorkspaceChange = useCallback(
    (workspaceId: string | undefined) => {
      onUpdate?.({ workspaceId });
      setOpenPicker(null);
    },
    [onUpdate]
  );

  const handleDateChange = useCallback(
    (field: "startDate" | "targetDate", date: Date | null) => {
      onUpdate?.({ [field]: date?.toISOString() || undefined });
      setOpenPicker(null);
    },
    [onUpdate]
  );

  const formatDate = useCallback(
    (dateStr?: string): string => {
      if (!dateStr) return t("properties.addDate");
      const date = new Date(dateStr);
      return date.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      });
    },
    [t]
  );

  return {
    t,
    containerRef,
    openPicker,
    togglePicker,
    closePicker,
    currentStatus,
    currentPriority,
    currentHealth,
    handleStatusChange,
    handlePriorityChange,
    handleHealthChange,
    handleLeadChange,
    handleMemberToggle,
    handleTeamToggle,
    handleLabelToggle,
    handleLinkedRepoToggle,
    handleWorkspaceChange,
    handleDateChange,
    formatDate,
  };
}
