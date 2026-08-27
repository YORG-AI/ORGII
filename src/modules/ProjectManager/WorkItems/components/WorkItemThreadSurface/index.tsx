import React from "react";
import { useTranslation } from "react-i18next";

import { PropertiesPanel } from "@src/modules/ProjectManager/shared";
import { WorkstationTrailSurface } from "@src/modules/shared/layouts/blocks";

import WorkItemContent from "../WorkItemContent";
import type { WorkItemContentProps } from "../WorkItemContent/types";
import WorkItemProperties, {
  WORK_ITEM_THREAD_PROPERTY_FIELDS,
} from "../WorkItemProperties";
import type {
  WorkItemPropertiesProps,
  WorkItemPropertyFieldKey,
} from "../WorkItemProperties/types";

type ThreadPropertyProps = Omit<
  WorkItemPropertiesProps,
  "workItem" | "fieldVariant" | "pillLayout" | "visibleFields" | "panelVariant"
>;

interface WorkItemThreadSurfaceProps extends Omit<
  WorkItemContentProps,
  "presentation" | "headerProperties" | "propertiesRail"
> {
  /**
   * Omit this configuration when the thread has no editable property source.
   * The content remains readable and keeps the same thread presentation.
   */
  propertyProps?: ThreadPropertyProps;
  /** Limit the canonical property set to fields backed by this data source. */
  propertyFields?: WorkItemPropertyFieldKey[];
  /**
   * `band` keeps the inline pill row above the thread; `rail` moves the same
   * properties into the Workstation trail rail beside the thread, matching the
   * chat-panel Work Item rail and the pull-request details rail.
   */
  propertiesPlacement?: "band" | "rail";
}

/**
 * Canonical Work Item thread composition used by embedded and full-page
 * surfaces. Navigation shells remain independent, while content hierarchy,
 * metadata density, and responsive pill behavior stay identical.
 */
const WorkItemThreadSurface: React.FC<WorkItemThreadSurfaceProps> = ({
  workItem,
  propertyProps,
  propertyFields = WORK_ITEM_THREAD_PROPERTY_FIELDS,
  propertiesPlacement = "band",
  ...contentProps
}) => {
  const { t } = useTranslation("projects");
  const railPlacement = propertiesPlacement === "rail";

  const headerProperties =
    propertyProps && !railPlacement ? (
      <WorkItemProperties
        {...propertyProps}
        workItem={workItem}
        fieldVariant="pill"
        pillLayout="wrap"
        visibleFields={propertyFields}
        showMoreMenu={propertyProps.showMoreMenu ?? true}
      />
    ) : undefined;

  const propertiesRail =
    propertyProps && railPlacement ? (
      <WorkstationTrailSurface className="flex self-start">
        <PropertiesPanel
          title={t("workItems.properties.title")}
          fitContent
          headerVariant="workstation-trail"
        >
          <WorkItemProperties
            {...propertyProps}
            workItem={workItem}
            visibleFields={propertyFields}
            panelVariant="workstation-trail"
          />
        </PropertiesPanel>
      </WorkstationTrailSurface>
    ) : undefined;

  return (
    <WorkItemContent
      key={workItem.session_id}
      {...contentProps}
      workItem={workItem}
      presentation="thread"
      headerProperties={headerProperties}
      propertiesRail={propertiesRail}
    />
  );
};

export default WorkItemThreadSurface;
