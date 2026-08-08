import React from "react";

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
  "workItem" | "fieldVariant" | "pillLayout" | "visibleFields"
>;

interface WorkItemThreadSurfaceProps extends Omit<
  WorkItemContentProps,
  "presentation" | "headerProperties"
> {
  /**
   * Omit this configuration when the thread has no editable property source.
   * The content remains readable and keeps the same thread presentation.
   */
  propertyProps?: ThreadPropertyProps;
  /** Limit the canonical pill row to fields backed by this data source. */
  propertyFields?: WorkItemPropertyFieldKey[];
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
  ...contentProps
}) => {
  const headerProperties = propertyProps ? (
    <WorkItemProperties
      {...propertyProps}
      workItem={workItem}
      fieldVariant="pill"
      pillLayout="wrap"
      visibleFields={propertyFields}
      showMoreMenu={propertyProps.showMoreMenu ?? true}
    />
  ) : undefined;

  return (
    <WorkItemContent
      key={workItem.session_id}
      {...contentProps}
      workItem={workItem}
      presentation="thread"
      headerProperties={headerProperties}
    />
  );
};

export default WorkItemThreadSurface;
