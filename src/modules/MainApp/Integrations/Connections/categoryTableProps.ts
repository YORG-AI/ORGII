import type { ComponentProps } from "react";

import type { useChannelState } from "../hooks/useChannelState";
import type { useConnectionsState } from "../hooks/useConnectionsState";
import type { AddAction } from "../types";
import type { ConnectionsTable } from "./Table/ConnectionsTable";

export type ConnectionsCategoryTableProps = ComponentProps<
  typeof ConnectionsTable
>;

export function getConnectionsCategoryTableProps(params: {
  channels: ReturnType<typeof useChannelState>;
  onSelectChannel: ReturnType<typeof useConnectionsState>["handleChannelClick"];
  onAddAction: (action: AddAction) => void;
}): ConnectionsCategoryTableProps {
  return {
    groupedChannels: params.channels.groupedChannels,
    projectConnections: params.channels.projectConnections,
    loading:
      !params.channels.loaded || params.channels.projectConnectionsLoading,
    onSelectChannel: params.onSelectChannel,
    onAdd: () => params.onAddAction("add-connection"),
    onRemoveChannel: params.channels.handleRemoveChannelRow,
    onRemoveProjectConnection: params.channels.handleRemoveProjectConnection,
  };
}
