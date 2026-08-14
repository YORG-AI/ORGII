import { buildCloudRemoteItemId } from "@src/features/Org2Cloud/cloudRemoteItemId";
import type { CloudPendingPlay } from "@src/features/Org2Cloud/cloudSessionDownloadControlAtoms";
import type { CloudSessionDownloadProgress } from "@src/features/Org2Cloud/cloudSessionDownloadProgressAtom";

type CloudDownloadRowIdentity = Pick<
  CloudPendingPlay | CloudSessionDownloadProgress,
  "orgId" | "rowId"
>;

export function resolveCloudDownloadMenuItemId(
  orgId: string | null,
  downloadIdentity: CloudDownloadRowIdentity | null | undefined
): string | null {
  if (!orgId || downloadIdentity?.orgId !== orgId) return null;
  return buildCloudRemoteItemId(orgId, downloadIdentity.rowId);
}
