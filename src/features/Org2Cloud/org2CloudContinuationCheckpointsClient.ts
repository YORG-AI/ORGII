/**
 * Typed client for the encrypted continuation-checkpoint plane.
 *
 * This module never receives plaintext conversation data or private device
 * keys. Rust owns portable serialization, signing, encryption and decryption;
 * TypeScript transports only public routing metadata and opaque ciphertext.
 */
import { z } from "zod/v4";

import { createLogger } from "@src/hooks/logger";

import {
  type CloudEndpoint,
  ORG2_CLOUD_POSTGREST_SCHEMA,
  getCloudEndpoint,
} from "./config";
import { fetchWithTransportRetry } from "./org2CloudFetchRetry";
import { endpointForOrg } from "./org2CloudOrgEndpointRouter";

const log = createLogger("Org2CloudContinuationCheckpoints");

export const CONTINUATION_CHECKPOINT_BUCKET = "continuation-checkpoints";
export const CONTINUATION_CHECKPOINT_MAX_OBJECT_BYTES = 16 * 1024 * 1024;

export const ORG2_CONTINUATION_ERROR_CODES = [
  "ORG2_AUTH_REQUIRED",
  "ORG2_CONFLICT",
  "ORG2_CONTINUATION_AUDIENCE_TOO_LARGE",
  "ORG2_CONTINUATION_AUDIENCE_UNCOVERED",
  "ORG2_CONTINUATION_CHECKPOINT_EXPIRED",
  "ORG2_CONTINUATION_CHECKPOINT_NOT_FOUND",
  "ORG2_CONTINUATION_CHECKPOINT_NOT_UPLOADED",
  "ORG2_CONTINUATION_CHECKPOINT_QUOTA",
  "ORG2_CONTINUATION_DEVICE_HISTORY_QUOTA",
  "ORG2_CONTINUATION_DEVICE_ID_COLLISION",
  "ORG2_CONTINUATION_DEVICE_NOT_ENCRYPT_CURRENT",
  "ORG2_CONTINUATION_DEVICE_NOT_FOUND",
  "ORG2_CONTINUATION_DEVICE_QUOTA",
  "ORG2_CONTINUATION_DEVICE_REVOKED",
  "ORG2_CONTINUATION_KEY_FINGERPRINT_MISMATCH",
  "ORG2_CONTINUATION_RECEIPT_QUOTA",
  "ORG2_CONTINUATION_RECIPIENT_SET_INVALID",
  "ORG2_CONTINUATION_RECIPIENT_SET_STALE",
  "ORG2_CONTINUATION_UPLOAD_INCOMPLETE",
  "ORG2_FORBIDDEN",
  "ORG2_MEMBER_REQUIRED",
  "ORG2_ORG_NOT_FOUND",
  "ORG2_VALIDATION",
] as const;

export type Org2ContinuationErrorCode =
  (typeof ORG2_CONTINUATION_ERROR_CODES)[number];

export class Org2CloudContinuationError extends Error {
  readonly code: Org2ContinuationErrorCode | null;
  readonly status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "Org2CloudContinuationError";
    this.status = status;
    const tokens = message.match(/\bORG2_[A-Z_]+\b/g) ?? [];
    this.code =
      (tokens.find((token) =>
        (ORG2_CONTINUATION_ERROR_CODES as readonly string[]).includes(token)
      ) as Org2ContinuationErrorCode | undefined) ?? null;
  }
}

export function isOrg2ContinuationErrorCode(
  error: unknown,
  code: Org2ContinuationErrorCode
): boolean {
  return error instanceof Org2CloudContinuationError && error.code === code;
}

const UuidSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const BASE64URL_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function canonicalBase64UrlByteLength(value: string): number | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) return null;
  const lastValue = BASE64URL_ALPHABET.indexOf(value.at(-1) ?? "");
  if (
    lastValue < 0 ||
    (value.length % 4 === 2 && (lastValue & 15) !== 0) ||
    (value.length % 4 === 3 && (lastValue & 3) !== 0)
  ) {
    return null;
  }
  return Math.floor((value.length * 6) / 8);
}

function canonicalBase64UrlSchema(expectedBytes?: number, maxBytes?: number) {
  return z.string().refine((value) => {
    const length = canonicalBase64UrlByteLength(value);
    return (
      length !== null &&
      (expectedBytes === undefined || length === expectedBytes) &&
      (maxBytes === undefined || length <= maxBytes)
    );
  });
}

const Base64Url32Schema = canonicalBase64UrlSchema(32);
const Base64Url64Schema = canonicalBase64UrlSchema(64);
const CanonicalHeaderSchema = canonicalBase64UrlSchema(undefined, 16 * 1024);
const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const PositiveIntSchema = z.number().int().positive();
const ObjectSizeSchema = z
  .number()
  .int()
  .min(1)
  .max(CONTINUATION_CHECKPOINT_MAX_OBJECT_BYTES);
const RuntimeSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/);
const PayloadSchemaIdSchema = z
  .string()
  .min(1)
  .refine((value) => new TextEncoder().encode(value).byteLength <= 128)
  .refine((value) =>
    Array.from(value).every((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint > 31 && (codePoint < 127 || codePoint > 159);
    })
  );
const RecipientScopeSchema = z.enum(["audience", "subset"]);

const DeviceRegistrationSchema = z.strictObject({
  orgId: UuidSchema,
  deviceId: UuidSchema,
  keyVersion: PositiveIntSchema,
  keyFingerprint: Sha256Schema,
  encryptEligible: z.boolean(),
  deviceLabel: z.string().nullable(),
});

export type ContinuationDeviceRegistration = z.output<
  typeof DeviceRegistrationSchema
>;

const ContinuationDeviceSchema = DeviceRegistrationSchema.extend({
  encryptionPublicKey: Base64Url32Schema,
  encryptionAlgorithm: z.literal("x25519-v1"),
  signingPublicKey: Base64Url32Schema,
  signingAlgorithm: z.literal("ed25519-v1"),
  createdAt: z.string(),
  lastSeenAt: z.string(),
  supersededForEncryptAt: z.string().nullable(),
});

export type ContinuationDevice = z.output<typeof ContinuationDeviceSchema>;

const ListDevicesSchema = z.strictObject({
  devices: z.array(ContinuationDeviceSchema),
});

export const ContinuationPrepareRecipientSchema = z.strictObject({
  recipientUserId: UuidSchema,
  deviceId: UuidSchema,
  keyVersion: PositiveIntSchema,
});

export type ContinuationPrepareRecipient = z.output<
  typeof ContinuationPrepareRecipientSchema
>;

export const ContinuationRecipientSchema =
  ContinuationPrepareRecipientSchema.extend({
    encryptionPublicKey: Base64Url32Schema,
    encryptionAlgorithm: z.literal("x25519-v1"),
    signingPublicKey: Base64Url32Schema,
    signingAlgorithm: z.literal("ed25519-v1"),
    keyFingerprint: Sha256Schema,
  });

export type ContinuationRecipient = z.output<
  typeof ContinuationRecipientSchema
>;

const ResolvedRecipientsSchema = z.discriminatedUnion("checkpointable", [
  z.strictObject({
    checkpointable: z.literal(true),
    recipientScope: RecipientScopeSchema,
    recipientCount: z.number().int().min(1).max(64),
    recipientSetSha256: Sha256Schema,
    prepareRecipients: z.array(ContinuationPrepareRecipientSchema).min(1),
    recipients: z.array(ContinuationRecipientSchema).min(1),
  }),
  z.strictObject({
    checkpointable: z.literal(false),
    recipientScope: RecipientScopeSchema,
    reason: z.enum([
      "uncoveredAudience",
      "audienceTooLarge",
      "deviceIdCollision",
    ]),
    recipientCount: z.number().int().min(0),
    uncoveredUserIds: z.array(UuidSchema).optional(),
  }),
]);

export type ResolvedContinuationRecipients = z.output<
  typeof ResolvedRecipientsSchema
>;

const ReceiptRecipientSchema = z.strictObject({
  recipientUserId: UuidSchema,
  deviceId: UuidSchema,
  keyVersion: PositiveIntSchema,
  encryptionPublicKey: Base64Url32Schema,
  signingPublicKey: Base64Url32Schema,
  keyFingerprint: Sha256Schema,
  status: z.enum(["pending", "acknowledged", "revoked"]),
});

export const ContinuationPrepareReceiptSchema = z.strictObject({
  checkpointId: UuidSchema,
  bucket: z.literal(CONTINUATION_CHECKPOINT_BUCKET),
  objectPath: z.string().min(1),
  objectSize: ObjectSizeSchema,
  objectSha256: Sha256Schema,
  ageCiphertextLen: ObjectSizeSchema,
  ageCiphertextSha256: Sha256Schema,
  footerSignature: Base64Url64Schema,
  status: z.enum(["prepared", "uploaded", "committed", "revoked"]),
  senderUserId: UuidSchema,
  senderDeviceId: UuidSchema,
  senderKeyVersion: PositiveIntSchema,
  senderEncryptionPublicKey: Base64Url32Schema,
  senderSigningPublicKey: Base64Url32Schema,
  senderKeyFingerprint: Sha256Schema,
  sourceEpisodeId: z.string().min(1),
  sourceRuntime: RuntimeSchema,
  payloadSchema: PayloadSchemaIdSchema,
  payloadSchemaVersion: z.number().int().min(1).max(65535),
  recipientScope: RecipientScopeSchema,
  recipientCount: z.number().int().min(1).max(64),
  recipientSetSha256: Sha256Schema,
  canonicalHeader: CanonicalHeaderSchema,
  clientCreatedAt: z.string(),
  createdAt: z.string(),
  expiresAt: z.string(),
  envelopeVersion: z.literal(1),
  recipients: z.array(ReceiptRecipientSchema).min(1),
});

export type ContinuationPrepareReceipt = z.output<
  typeof ContinuationPrepareReceiptSchema
>;

const CheckpointMutationSchema = z.strictObject({
  ok: z.boolean(),
  checkpointId: UuidSchema,
  status: z.enum(["uploaded", "committed", "revoked"]),
  uploadedAt: z.string().nullable().optional(),
  committedAt: z.string().nullable().optional(),
  reason: z
    .enum(["noEligibleRoute", "senderForbidden", "noEligibleRecipients"])
    .optional(),
  eligibleReceipts: z.number().int().min(0).optional(),
  revokedReceipts: z.number().int().min(0).optional(),
});

export type ContinuationCheckpointMutation = z.output<
  typeof CheckpointMutationSchema
>;

const RevokeDeviceSchema = z.strictObject({
  ok: z.literal(true),
  orgId: UuidSchema,
  deviceId: UuidSchema,
  keyVersion: PositiveIntSchema,
  alreadyRevoked: z.boolean().optional(),
  revokedSenderObjects: z.number().int().min(0).optional(),
  revokedReceipts: z.number().int().min(0).optional(),
});

const AckSchema = z.strictObject({
  ok: z.literal(true),
  checkpointId: UuidSchema,
  status: z.literal("acknowledged"),
  acknowledgedAt: z.string(),
});

const RevokeCheckpointSchema = z.strictObject({
  ok: z.literal(true),
  checkpointId: UuidSchema,
  status: z.literal("revoked"),
});

export const ContinuationCheckpointItemSchema = z.strictObject({
  checkpointId: UuidSchema,
  orgId: UuidSchema,
  rootSessionId: z.string().min(1),
  sourceEpisodeId: z.string().min(1),
  clientCreatedAt: z.string(),
  senderUserId: UuidSchema,
  senderDeviceId: UuidSchema,
  senderKeyVersion: PositiveIntSchema,
  senderKeyFingerprint: Sha256Schema,
  senderEncryptionPublicKey: Base64Url32Schema,
  senderSigningPublicKey: Base64Url32Schema,
  recipientUserId: UuidSchema,
  recipientDeviceId: UuidSchema,
  recipientKeyVersion: PositiveIntSchema,
  recipientKeyFingerprint: Sha256Schema,
  recipientEncryptionPublicKey: Base64Url32Schema,
  recipientSigningPublicKey: Base64Url32Schema,
  recipientScope: RecipientScopeSchema,
  recipientCount: z.number().int().min(1).max(64),
  recipientSetSha256: Sha256Schema,
  canonicalHeader: CanonicalHeaderSchema,
  sourceRuntime: RuntimeSchema,
  payloadSchema: PayloadSchemaIdSchema,
  payloadSchemaVersion: z.number().int().min(1).max(65535),
  envelopeVersion: z.literal(1),
  bucket: z.literal(CONTINUATION_CHECKPOINT_BUCKET),
  objectPath: z.string().min(1),
  objectSize: ObjectSizeSchema,
  objectSha256: Sha256Schema,
  ageCiphertextLen: ObjectSizeSchema,
  ageCiphertextSha256: Sha256Schema,
  footerSignature: Base64Url64Schema,
  createdAt: z.string(),
  committedAt: z.string(),
  expiresAt: z.string(),
});

export type ContinuationCheckpointItem = z.output<
  typeof ContinuationCheckpointItemSchema
>;

const ListCheckpointsSchema = z.strictObject({
  items: z.array(ContinuationCheckpointItemSchema),
  nextCreatedAt: z.string().nullable(),
  nextCheckpointId: UuidSchema.nullable(),
});

export interface ContinuationCheckpointPage {
  items: ContinuationCheckpointItem[];
  nextCreatedAt: string | null;
  nextCheckpointId: string | null;
}

interface ContinuationRequestOptions {
  endpoint?: CloudEndpoint;
  signal?: AbortSignal;
}

function rpcUrl(functionName: string, endpoint: CloudEndpoint): string {
  return `${endpoint.supabaseUrl}/rest/v1/rpc/${functionName}`;
}

function authHeaders(
  accessToken: string,
  endpoint: CloudEndpoint
): Record<string, string> {
  return {
    apikey: endpoint.anonKey,
    authorization: `Bearer ${accessToken}`,
  };
}

async function callContinuationRpc(
  functionName: string,
  accessToken: string,
  body: Record<string, unknown>,
  endpoint: CloudEndpoint,
  signal?: AbortSignal
): Promise<unknown> {
  const response = await fetchWithTransportRetry(
    rpcUrl(functionName, endpoint),
    {
      method: "POST",
      headers: {
        ...authHeaders(accessToken, endpoint),
        "content-type": "application/json",
        "content-profile": ORG2_CLOUD_POSTGREST_SCHEMA,
      },
      body: JSON.stringify(body),
      signal,
    }
  );
  const text = await response.text();
  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const message =
      payload && typeof payload === "object" && "message" in payload
        ? String((payload as { message: unknown }).message)
        : `org2_cloud rpc ${functionName} failed with ${response.status}`;
    throw new Org2CloudContinuationError(message, response.status);
  }
  return payload;
}

function parseRpc<T>(
  functionName: string,
  schema: z.ZodType<T>,
  payload: unknown
): T {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    log.warn(`unparseable ${functionName} payload`, parsed.error);
    throw new Org2CloudContinuationError(`unparseable ${functionName} payload`);
  }
  return parsed.data;
}

function endpointFor(
  orgId: string,
  options: ContinuationRequestOptions | undefined
): CloudEndpoint {
  return options?.endpoint ?? endpointForOrg(orgId);
}

function metadataConflict(message: string): never {
  throw new Org2CloudContinuationError(`ORG2_CONFLICT: ${message}`);
}

function sameInstant(left: string, right: string): boolean {
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  return Number.isFinite(leftMs) && leftMs === rightMs;
}

function recipientRouteKey(route: ContinuationPrepareRecipient): string {
  return `${route.recipientUserId}\u0000${route.deviceId}\u0000${route.keyVersion}`;
}

export async function registerContinuationDevice(
  accessToken: string,
  params: {
    orgId: string;
    deviceId: string;
    keyVersion: number;
    encryptionPublicKey: string;
    signingPublicKey: string;
    keyFingerprint: string;
    deviceLabel?: string | null;
  },
  options?: ContinuationRequestOptions
): Promise<ContinuationDeviceRegistration> {
  const payload = await callContinuationRpc(
    "cloud_register_continuation_device",
    accessToken,
    {
      p_org_id: params.orgId,
      p_device_id: params.deviceId,
      p_key_version: params.keyVersion,
      p_encryption_public_key: params.encryptionPublicKey,
      p_signing_public_key: params.signingPublicKey,
      p_key_fingerprint: params.keyFingerprint,
      p_device_label: params.deviceLabel ?? null,
    },
    endpointFor(params.orgId, options),
    options?.signal
  );
  const result = parseRpc(
    "cloud_register_continuation_device",
    DeviceRegistrationSchema,
    payload
  );
  if (
    result.orgId !== params.orgId ||
    result.deviceId !== params.deviceId ||
    result.keyVersion !== params.keyVersion ||
    result.keyFingerprint !== params.keyFingerprint
  ) {
    metadataConflict("registered device receipt does not match the request");
  }
  return result;
}

export async function listContinuationDevices(
  accessToken: string,
  orgId: string,
  options?: ContinuationRequestOptions
): Promise<ContinuationDevice[]> {
  const payload = await callContinuationRpc(
    "cloud_list_continuation_devices",
    accessToken,
    { p_org_id: orgId },
    endpointFor(orgId, options),
    options?.signal
  );
  const result = parseRpc(
    "cloud_list_continuation_devices",
    ListDevicesSchema,
    payload
  ).devices;
  if (result.some((device) => device.orgId !== orgId)) {
    metadataConflict("device listing crossed its requested org");
  }
  return result;
}

export async function revokeContinuationDevice(
  accessToken: string,
  params: { orgId: string; deviceId: string; keyVersion: number },
  options?: ContinuationRequestOptions
): Promise<z.output<typeof RevokeDeviceSchema>> {
  const payload = await callContinuationRpc(
    "cloud_revoke_continuation_device",
    accessToken,
    {
      p_org_id: params.orgId,
      p_device_id: params.deviceId,
      p_key_version: params.keyVersion,
    },
    endpointFor(params.orgId, options),
    options?.signal
  );
  const result = parseRpc(
    "cloud_revoke_continuation_device",
    RevokeDeviceSchema,
    payload
  );
  if (
    result.orgId !== params.orgId ||
    result.deviceId !== params.deviceId ||
    result.keyVersion !== params.keyVersion
  ) {
    metadataConflict("revoked device receipt does not match the request");
  }
  return result;
}

export async function resolveContinuationRecipients(
  accessToken: string,
  params: {
    orgId: string;
    rootSessionId: string;
    recipientScope: "audience" | "subset";
    subsetUserIds?: string[] | null;
  },
  options?: ContinuationRequestOptions
): Promise<ResolvedContinuationRecipients> {
  const payload = await callContinuationRpc(
    "cloud_resolve_continuation_recipients",
    accessToken,
    {
      p_org_id: params.orgId,
      p_root_session_id: params.rootSessionId,
      p_recipient_scope: params.recipientScope,
      p_subset_user_ids: params.subsetUserIds ?? null,
    },
    endpointFor(params.orgId, options),
    options?.signal
  );
  const result = parseRpc(
    "cloud_resolve_continuation_recipients",
    ResolvedRecipientsSchema,
    payload
  );
  if (result.recipientScope !== params.recipientScope) {
    metadataConflict("recipient resolution changed the requested scope");
  }
  if (result.checkpointable) {
    const prepareRoutes = result.prepareRecipients.map(recipientRouteKey);
    const fullRoutes = result.recipients.map(recipientRouteKey);
    if (
      result.recipientCount !== prepareRoutes.length ||
      result.recipientCount !== fullRoutes.length ||
      new Set(prepareRoutes).size !== prepareRoutes.length ||
      prepareRoutes.some((route, index) => route !== fullRoutes[index])
    ) {
      metadataConflict("recipient resolution returned inconsistent routes");
    }
  }
  return result;
}

export interface PrepareContinuationCheckpointInput {
  checkpointId: string;
  orgId: string;
  rootSessionId: string;
  sourceEpisodeId: string;
  clientCreatedAt: string;
  senderDeviceId: string;
  senderKeyVersion: number;
  recipientScope: "audience" | "subset";
  recipients: ContinuationPrepareRecipient[];
  recipientSetSha256: string;
  canonicalHeader: string;
  sourceRuntime: string;
  payloadSchema: string;
  payloadSchemaVersion: number;
  objectSize: number;
  objectSha256: string;
  ageCiphertextLen: number;
  ageCiphertextSha256: string;
  footerSignature: string;
  expiresAt: string;
}

function assertPrepareReceiptMatchesInput(
  receipt: ContinuationPrepareReceipt,
  input: PrepareContinuationCheckpointInput
): void {
  const requestedRoutes = input.recipients.map(recipientRouteKey);
  const receiptRoutes = receipt.recipients.map(recipientRouteKey);
  if (
    receipt.checkpointId !== input.checkpointId ||
    receipt.objectPath !==
      buildContinuationCheckpointObjectPath(
        input.orgId,
        input.checkpointId,
        input.objectSha256
      ) ||
    receipt.objectSize !== input.objectSize ||
    receipt.objectSha256 !== input.objectSha256 ||
    receipt.ageCiphertextLen !== input.ageCiphertextLen ||
    receipt.ageCiphertextSha256 !== input.ageCiphertextSha256 ||
    receipt.footerSignature !== input.footerSignature ||
    receipt.senderDeviceId !== input.senderDeviceId ||
    receipt.senderKeyVersion !== input.senderKeyVersion ||
    receipt.sourceEpisodeId !== input.sourceEpisodeId ||
    receipt.sourceRuntime !== input.sourceRuntime ||
    receipt.payloadSchema !== input.payloadSchema ||
    receipt.payloadSchemaVersion !== input.payloadSchemaVersion ||
    receipt.recipientScope !== input.recipientScope ||
    receipt.recipientCount !== input.recipients.length ||
    receipt.recipientSetSha256 !== input.recipientSetSha256 ||
    receipt.canonicalHeader !== input.canonicalHeader ||
    !sameInstant(receipt.clientCreatedAt, input.clientCreatedAt) ||
    !sameInstant(receipt.expiresAt, input.expiresAt) ||
    requestedRoutes.length !== receiptRoutes.length ||
    requestedRoutes.some((route, index) => route !== receiptRoutes[index])
  ) {
    metadataConflict(
      "prepared checkpoint receipt does not match local envelope"
    );
  }
}

export async function prepareContinuationCheckpoint(
  accessToken: string,
  input: PrepareContinuationCheckpointInput,
  options?: ContinuationRequestOptions
): Promise<ContinuationPrepareReceipt> {
  const payload = await callContinuationRpc(
    "cloud_prepare_continuation_checkpoint",
    accessToken,
    {
      p_checkpoint_id: input.checkpointId,
      p_org_id: input.orgId,
      p_root_session_id: input.rootSessionId,
      p_source_episode_id: input.sourceEpisodeId,
      p_client_created_at: input.clientCreatedAt,
      p_sender_device_id: input.senderDeviceId,
      p_sender_key_version: input.senderKeyVersion,
      p_recipient_scope: input.recipientScope,
      p_recipients: input.recipients,
      p_recipient_set_sha256: input.recipientSetSha256,
      p_canonical_header: input.canonicalHeader,
      p_source_runtime: input.sourceRuntime,
      p_payload_schema: input.payloadSchema,
      p_payload_schema_version: input.payloadSchemaVersion,
      p_object_size: input.objectSize,
      p_object_sha256: input.objectSha256,
      p_age_ciphertext_len: input.ageCiphertextLen,
      p_age_ciphertext_sha256: input.ageCiphertextSha256,
      p_footer_signature: input.footerSignature,
      p_expires_at: input.expiresAt,
    },
    endpointFor(input.orgId, options),
    options?.signal
  );
  const result = parseRpc(
    "cloud_prepare_continuation_checkpoint",
    ContinuationPrepareReceiptSchema,
    payload
  );
  assertPrepareReceiptMatchesInput(result, input);
  return result;
}

async function mutateCheckpoint(
  functionName: string,
  accessToken: string,
  checkpointId: string,
  options?: ContinuationRequestOptions
): Promise<ContinuationCheckpointMutation> {
  const payload = await callContinuationRpc(
    functionName,
    accessToken,
    { p_checkpoint_id: checkpointId },
    options?.endpoint ?? getCloudEndpoint(),
    options?.signal
  );
  const result = parseRpc(functionName, CheckpointMutationSchema, payload);
  if (result.checkpointId !== checkpointId) {
    metadataConflict(`${functionName} receipt changed checkpoint identity`);
  }
  return result;
}

export function markContinuationCheckpointUploaded(
  accessToken: string,
  checkpointId: string,
  options?: ContinuationRequestOptions
): Promise<ContinuationCheckpointMutation> {
  return mutateCheckpoint(
    "cloud_mark_continuation_checkpoint_uploaded",
    accessToken,
    checkpointId,
    options
  );
}

export function commitContinuationCheckpoint(
  accessToken: string,
  checkpointId: string,
  options?: ContinuationRequestOptions
): Promise<ContinuationCheckpointMutation> {
  return mutateCheckpoint(
    "cloud_commit_continuation_checkpoint",
    accessToken,
    checkpointId,
    options
  );
}

export async function listContinuationCheckpoints(
  accessToken: string,
  params: {
    orgId: string;
    deviceId: string;
    keyVersion: number;
    afterCreatedAt?: string | null;
    afterCheckpointId?: string | null;
    limit?: number;
  },
  options?: ContinuationRequestOptions
): Promise<ContinuationCheckpointPage> {
  if ((params.afterCreatedAt == null) !== (params.afterCheckpointId == null)) {
    throw new Org2CloudContinuationError(
      "ORG2_VALIDATION: both continuation checkpoint cursors are required"
    );
  }
  const payload = await callContinuationRpc(
    "cloud_list_continuation_checkpoints",
    accessToken,
    {
      p_org_id: params.orgId,
      p_device_id: params.deviceId,
      p_key_version: params.keyVersion,
      p_after_created_at: params.afterCreatedAt ?? null,
      p_after_checkpoint_id: params.afterCheckpointId ?? null,
      p_limit: params.limit ?? 50,
    },
    endpointFor(params.orgId, options),
    options?.signal
  );
  const result = parseRpc(
    "cloud_list_continuation_checkpoints",
    ListCheckpointsSchema,
    payload
  );
  if (
    result.items.some(
      (item) =>
        item.orgId !== params.orgId ||
        item.recipientDeviceId !== params.deviceId ||
        item.recipientKeyVersion !== params.keyVersion ||
        item.objectPath !==
          buildContinuationCheckpointObjectPath(
            item.orgId,
            item.checkpointId,
            item.objectSha256
          )
    )
  ) {
    metadataConflict("checkpoint inbox crossed its requested device route");
  }
  return result;
}

export async function acknowledgeContinuationCheckpoint(
  accessToken: string,
  params: { checkpointId: string; deviceId: string; keyVersion: number },
  options?: ContinuationRequestOptions
): Promise<z.output<typeof AckSchema>> {
  const payload = await callContinuationRpc(
    "cloud_ack_continuation_checkpoint",
    accessToken,
    {
      p_checkpoint_id: params.checkpointId,
      p_device_id: params.deviceId,
      p_key_version: params.keyVersion,
    },
    options?.endpoint ?? getCloudEndpoint(),
    options?.signal
  );
  const result = parseRpc(
    "cloud_ack_continuation_checkpoint",
    AckSchema,
    payload
  );
  if (result.checkpointId !== params.checkpointId) {
    metadataConflict("ack receipt changed checkpoint identity");
  }
  return result;
}

export async function revokeContinuationCheckpoint(
  accessToken: string,
  checkpointId: string,
  options?: ContinuationRequestOptions
): Promise<z.output<typeof RevokeCheckpointSchema>> {
  const payload = await callContinuationRpc(
    "cloud_revoke_continuation_checkpoint",
    accessToken,
    { p_checkpoint_id: checkpointId },
    options?.endpoint ?? getCloudEndpoint(),
    options?.signal
  );
  const result = parseRpc(
    "cloud_revoke_continuation_checkpoint",
    RevokeCheckpointSchema,
    payload
  );
  if (result.checkpointId !== checkpointId) {
    metadataConflict("revoke receipt changed checkpoint identity");
  }
  return result;
}

export interface ContinuationCiphertextDescriptor {
  checkpointId: string;
  orgId: string;
  objectPath: string;
  objectSize: number;
  objectSha256: string;
}

export function buildContinuationCheckpointObjectPath(
  orgId: string,
  checkpointId: string,
  objectSha256: string
): string {
  return `${orgId}/${checkpointId}/${objectSha256}.age`;
}

function storageObjectUrl(path: string, endpoint: CloudEndpoint): string {
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  return `${endpoint.supabaseUrl}/storage/v1/object/${CONTINUATION_CHECKPOINT_BUCKET}/${encodedPath}`;
}

function validateCiphertextDescriptor(
  descriptor: ContinuationCiphertextDescriptor
): void {
  if (
    !UuidSchema.safeParse(descriptor.orgId).success ||
    !UuidSchema.safeParse(descriptor.checkpointId).success ||
    !Sha256Schema.safeParse(descriptor.objectSha256).success ||
    !ObjectSizeSchema.safeParse(descriptor.objectSize).success ||
    descriptor.objectPath !==
      buildContinuationCheckpointObjectPath(
        descriptor.orgId,
        descriptor.checkpointId,
        descriptor.objectSha256
      )
  ) {
    throw new Org2CloudContinuationError(
      "ORG2_VALIDATION: invalid continuation ciphertext descriptor"
    );
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new Uint8Array(bytes)
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

async function assertCiphertextMatchesDescriptor(
  descriptor: ContinuationCiphertextDescriptor,
  bytes: Uint8Array
): Promise<void> {
  validateCiphertextDescriptor(descriptor);
  if (
    bytes.byteLength !== descriptor.objectSize ||
    (await sha256Hex(bytes)) !== descriptor.objectSha256
  ) {
    throw new Org2CloudContinuationError(
      "ORG2_CONFLICT: continuation ciphertext size or SHA-256 mismatch"
    );
  }
}

async function readBoundedCiphertext(response: Response): Promise<Uint8Array> {
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength !== null &&
    (!/^\d+$/.test(declaredLength) ||
      Number(declaredLength) > CONTINUATION_CHECKPOINT_MAX_OBJECT_BYTES)
  ) {
    throw new Org2CloudContinuationError(
      "ORG2_VALIDATION: continuation ciphertext exceeds 16 MiB"
    );
  }
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > CONTINUATION_CHECKPOINT_MAX_OBJECT_BYTES) {
      throw new Org2CloudContinuationError(
        "ORG2_VALIDATION: continuation ciphertext exceeds 16 MiB"
      );
    }
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > CONTINUATION_CHECKPOINT_MAX_OBJECT_BYTES) {
      await reader.cancel();
      throw new Org2CloudContinuationError(
        "ORG2_VALIDATION: continuation ciphertext exceeds 16 MiB"
      );
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function downloadContinuationCheckpointObject(
  accessToken: string,
  descriptor: ContinuationCiphertextDescriptor,
  endpoint: CloudEndpoint = getCloudEndpoint(),
  signal?: AbortSignal
): Promise<Uint8Array> {
  validateCiphertextDescriptor(descriptor);
  const response = await fetchWithTransportRetry(
    storageObjectUrl(descriptor.objectPath, endpoint),
    {
      method: "GET",
      headers: authHeaders(accessToken, endpoint),
      signal,
    }
  );
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Org2CloudContinuationError(
      `continuation ciphertext download failed with ${response.status}` +
        (body ? `: ${body.slice(0, 300)}` : ""),
      response.status
    );
  }
  const bytes = await readBoundedCiphertext(response);
  await assertCiphertextMatchesDescriptor(descriptor, bytes);
  return bytes;
}

async function existingCiphertextMatches(
  accessToken: string,
  descriptor: ContinuationCiphertextDescriptor,
  endpoint: CloudEndpoint,
  signal?: AbortSignal
): Promise<boolean> {
  try {
    await downloadContinuationCheckpointObject(
      accessToken,
      descriptor,
      endpoint,
      signal
    );
    return true;
  } catch (error) {
    if (isAbortError(error)) throw error;
    if (
      error instanceof Org2CloudContinuationError &&
      (error.status === null || error.code === "ORG2_CONFLICT")
    ) {
      throw error;
    }
    return false;
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export async function uploadContinuationCheckpointObject(
  accessToken: string,
  descriptor: ContinuationCiphertextDescriptor,
  bytes: Uint8Array,
  endpoint: CloudEndpoint = getCloudEndpoint(),
  signal?: AbortSignal
): Promise<void> {
  await assertCiphertextMatchesDescriptor(descriptor, bytes);
  let response: Response;
  try {
    response = await fetchWithTransportRetry(
      storageObjectUrl(descriptor.objectPath, endpoint),
      {
        method: "POST",
        headers: {
          ...authHeaders(accessToken, endpoint),
          "content-type": "application/octet-stream",
        },
        body: new Uint8Array(bytes),
        signal,
      }
    );
  } catch (error) {
    if (isAbortError(error)) throw error;
    if (
      await existingCiphertextMatches(accessToken, descriptor, endpoint, signal)
    ) {
      return;
    }
    throw error;
  }
  if (response.ok) return;
  const body = await response.text().catch(() => "");
  if (
    [400, 403, 409].includes(response.status) &&
    (await existingCiphertextMatches(accessToken, descriptor, endpoint, signal))
  ) {
    return;
  }
  throw new Org2CloudContinuationError(
    `continuation ciphertext upload failed with ${response.status}` +
      (body ? `: ${body.slice(0, 300)}` : ""),
    response.status
  );
}
