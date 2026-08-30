/**
 * SecretCaptureModal
 *
 * Global overlay that owns the `manage_secrets { action: "request" }`
 * round-trip. Mounted once at the app root by AppDeferredServices.
 *
 * Flow:
 *   1. Rust `manage_secrets` tool calls `SecretBroker::ask`, which
 *      broadcasts `agent:secret_request`. The Rust→FE adapter forwards it
 *      as a `window` CustomEvent on `AGENT_SIDE_CHANNEL_EVENTS.SECRET_REQUEST`.
 *   2. This component listens, pops the modal with the request metadata
 *      (label / kind / prompt), and renders a masked password input.
 *   3. On submit, we invoke `agent_secret_capture_submit` — the plaintext
 *      travels from the renderer process straight to Rust IPC and never
 *      touches the EventStore, the chat transcript, or the LLM transcript.
 *   4. On cancel / Esc / mask click we invoke `agent_secret_capture_cancel`.
 *
 * Security guarantees enforced here:
 *   - `<input type="password">` with `autoComplete="off"` and `spellCheck={false}`
 *   - No logging of the plaintext (only length / label on success/failure)
 *   - We wipe local React state immediately on dispatch
 *   - We do NOT keep the modal open after a submit/cancel — even if the
 *     Rust broker is slow to acknowledge, the plaintext leaves React state
 *     the moment the IPC promise rejects/resolves.
 */
import {
  type FC,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import { rpc } from "@src/api/tauri/rpc";
import Button from "@src/components/Button";
import Message from "@src/components/Message";
import {
  AGENT_SIDE_CHANNEL_EVENTS,
  type AgentSecretRequestDetail,
} from "@src/engines/SessionCore/sync/adapters/rustAgent/eventHandlers/fileChangeHandlers";
import { createLogger } from "@src/hooks/logger";
import {
  HugeiconsIcon,
  Key02Icon,
  LockIcon,
  SecurityCheckIcon,
} from "@src/icons";
import Modal from "@src/scaffold/ModalSystem";

const logger = createLogger("SecretCaptureModal");

type SecretKind = "api_key" | "password" | "oauth_token" | "other";

function isSecretKind(value: string): value is SecretKind {
  return (
    value === "api_key" ||
    value === "password" ||
    value === "oauth_token" ||
    value === "other"
  );
}

function kindIcon(kind: SecretKind) {
  switch (kind) {
    case "api_key":
      return (
        <HugeiconsIcon
          icon={Key02Icon}
          data-icon="key-round"
          size={16}
          aria-hidden
        />
      );
    case "oauth_token":
      return (
        <HugeiconsIcon
          icon={SecurityCheckIcon}
          data-icon="shield-check"
          size={16}
          aria-hidden
        />
      );
    case "password":
    case "other":
    default:
      return (
        <HugeiconsIcon icon={LockIcon} data-icon="lock" size={16} aria-hidden />
      );
  }
}

export const SecretCaptureModal: FC = () => {
  const { t } = useTranslation("common");

  const [request, setRequest] = useState<AgentSecretRequestDetail | null>(null);
  const [value, setValue] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();

  // ---------------------------------------------------------------------
  // Listen for incoming `agent:secret_request` events.
  //
  // If a second request arrives while a previous one is on-screen we
  // surface the new one and cancel the old request server-side, so the
  // broker does not leak a stale pending entry.
  // ---------------------------------------------------------------------
  useEffect(() => {
    function handleSecretRequest(event: Event) {
      const customEvent = event as CustomEvent<AgentSecretRequestDetail>;
      const detail = customEvent.detail;
      if (!detail || !detail.requestId || !detail.sessionId) return;

      setRequest((prev) => {
        if (prev && prev.requestId !== detail.requestId) {
          // Acknowledge that we are dropping the previous prompt. The
          // broker will mark the old request rejected on the Rust side
          // so the `manage_secrets` tool that was waiting on it surfaces
          // a rejection rather than hanging.
          rpc.agentSession
            .cancelSecret({
              sessionId: prev.sessionId,
              requestId: prev.requestId,
            })
            .catch((error: unknown) => {
              logger.warn("failed to cancel superseded secret request:", error);
            });
        }
        return detail;
      });
      setValue("");
      setSubmitting(false);
      logger.info(
        `received request label=${detail.label} kind=${detail.kind} session=${detail.sessionId}`
      );
    }

    window.addEventListener(
      AGENT_SIDE_CHANNEL_EVENTS.SECRET_REQUEST,
      handleSecretRequest
    );
    return () => {
      window.removeEventListener(
        AGENT_SIDE_CHANNEL_EVENTS.SECRET_REQUEST,
        handleSecretRequest
      );
    };
  }, []);

  // Auto-focus the masked input every time a fresh request arrives.
  useEffect(() => {
    if (!request) return;
    // Modal does its own focus-first-element pass; we override so the
    // masked input wins rather than the cancel button.
    const handle = window.setTimeout(() => {
      inputRef.current?.focus();
    }, 120);
    return () => window.clearTimeout(handle);
  }, [request]);

  const kind: SecretKind = useMemo(() => {
    if (!request) return "other";
    return isSecretKind(request.kind) ? request.kind : "other";
  }, [request]);

  const handleSubmit = useCallback(async () => {
    if (!request) return;
    if (value.length === 0) return;
    setSubmitting(true);
    const payload = {
      sessionId: request.sessionId,
      requestId: request.requestId,
      value,
    };
    // Wipe React state immediately so a stray re-render or devtools peek
    // cannot reveal the value while the IPC is in flight.
    setValue("");
    try {
      await rpc.agentSession.submitSecret(payload);
      logger.info(
        `submitted secret label=${request.label} length=${payload.value.length}`
      );
      setRequest(null);
    } catch (error) {
      logger.error("failed to submit secret:", error);
      Message.error(t("secretCapture.submitFailed"));
    } finally {
      // Defensive: clear payload reference in case the closure is held
      // somewhere up the stack.
      payload.value = "";
      setSubmitting(false);
    }
  }, [request, t, value]);

  const handleCancel = useCallback(async () => {
    if (!request) return;
    const { sessionId, requestId, label } = request;
    setRequest(null);
    setValue("");
    setSubmitting(false);
    try {
      await rpc.agentSession.cancelSecret({ sessionId, requestId });
      logger.info(`cancelled secret request label=${label}`);
    } catch (error) {
      logger.warn("failed to cancel secret request:", error);
    }
  }, [request]);

  const handlePasteFromClipboard = useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text.length === 0) {
        Message.warning(t("secretCapture.clipboardEmpty"));
        return;
      }
      setValue(text);
      // Re-focus and place caret at the end so the user can adjust if needed.
      requestAnimationFrame(() => {
        const node = inputRef.current;
        if (!node) return;
        node.focus();
        node.setSelectionRange(text.length, text.length);
      });
    } catch (error) {
      logger.warn("clipboard read failed:", error);
      Message.error(t("secretCapture.clipboardFailed"));
    }
  }, [t]);

  if (!request) return null;

  const submitDisabled = submitting || value.length === 0;

  const footer = (
    <div className="flex w-full items-center justify-between gap-2">
      <Button
        size="small"
        variant="secondary"
        onClick={handlePasteFromClipboard}
        disabled={submitting}
      >
        {t("secretCapture.pasteFromClipboard")}
      </Button>
      <div className="flex items-center gap-2">
        <Button
          size="small"
          variant="secondary"
          onClick={() => {
            void handleCancel();
          }}
          disabled={submitting}
        >
          {t("actions.cancel")}
        </Button>
        <Button
          size="small"
          variant="primary"
          onClick={() => {
            void handleSubmit();
          }}
          disabled={submitDisabled}
          loading={submitting}
        >
          {t("secretCapture.submit")}
        </Button>
      </div>
    </div>
  );

  return (
    <Modal
      visible={true}
      title={
        <div className="flex items-center gap-2 text-text-1">
          {kindIcon(kind)}
          <span className="text-sm font-medium">
            {t("secretCapture.title")}
          </span>
        </div>
      }
      onCancel={() => {
        void handleCancel();
      }}
      footer={footer}
      width={460}
      closable={!submitting}
      maskClosable={false}
      escToExit={!submitting}
    >
      <div className="flex flex-col gap-4">
        <div className="bg-warn-1/10 flex items-start gap-2 rounded-md px-3 py-2 text-xs text-text-2">
          <HugeiconsIcon
            icon={SecurityCheckIcon}
            data-icon="shield-check"
            size={14}
            className="text-warn-2 mt-[2px] shrink-0"
            aria-hidden
          />
          <span>{t("secretCapture.safetyNotice")}</span>
        </div>

        {request.prompt ? (
          <p className="text-sm text-text-1">{request.prompt}</p>
        ) : null}

        <label
          htmlFor={inputId}
          className="flex flex-col gap-1.5 text-xs text-text-3"
        >
          <span className="flex items-center gap-1.5 text-text-2">
            {kindIcon(kind)}
            <span className="font-mono text-[12px] text-text-1">
              {request.label}
            </span>
            <span className="text-text-3">·</span>
            <span>{t(`secretCapture.kind.${kind}`)}</span>
          </span>
          <input
            ref={inputRef}
            id={inputId}
            type="password"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !submitDisabled) {
                e.preventDefault();
                void handleSubmit();
              }
            }}
            disabled={submitting}
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            data-1p-ignore
            data-lpignore="true"
            placeholder={t("secretCapture.inputPlaceholder")}
            className="rounded-md border border-border-2 bg-bg-2 px-3 py-2 text-sm text-text-1 outline-none focus:border-border-3"
          />
          <span className="text-[11px] text-text-3">
            {t("secretCapture.lengthHint", { count: value.length })}
          </span>
        </label>
      </div>
    </Modal>
  );
};

export default SecretCaptureModal;
