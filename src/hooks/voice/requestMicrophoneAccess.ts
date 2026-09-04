export type MicrophoneAccessResult = "granted" | "denied" | "unsupported";

export type MicrophonePermissionState =
  | "granted"
  | "denied"
  | "prompt"
  | "unknown";

/** Non-disruptive microphone permission probe via the Permissions API. */
export async function queryMicrophonePermission(): Promise<MicrophonePermissionState> {
  if (typeof navigator === "undefined" || !navigator.permissions?.query) {
    return "unknown";
  }

  try {
    const status = await navigator.permissions.query({
      name: "microphone" as PermissionName,
    });
    if (
      status.state === "granted" ||
      status.state === "denied" ||
      status.state === "prompt"
    ) {
      return status.state;
    }
    return "unknown";
  } catch {
    return "unknown";
  }
}

export function mapGetUserMediaError(err: unknown): MicrophoneAccessResult {
  const name =
    err && typeof err === "object" && "name" in err
      ? String((err as { name: unknown }).name)
      : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "denied";
  }
  if (name === "NotFoundError" || name === "NotReadableError") {
    return "unsupported";
  }
  return "denied";
}

/**
 * Triggers the browser microphone prompt via getUserMedia. Captured tracks are
 * stopped immediately — callers only need the grant before starting speech
 * recognition or MediaRecorder.
 */
export async function requestMicrophoneAccess(): Promise<MicrophoneAccessResult> {
  if (
    typeof navigator === "undefined" ||
    !navigator.mediaDevices?.getUserMedia
  ) {
    return "unsupported";
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((track) => track.stop());
    return "granted";
  } catch (err) {
    return mapGetUserMediaError(err);
  }
}
