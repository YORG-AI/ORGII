export const WEBVIEW_LAYOUT_CHANGED_EVENT = "orgii-webview-layout-changed";
export const WEBVIEW_NATIVE_FRAME_UPDATED_EVENT =
  "orgii-webview-native-frame-updated";

export interface WebviewNativeFrameUpdatedDetail {
  label: string;
}

export function dispatchWebviewLayoutChanged(): void {
  requestAnimationFrame(() => {
    window.dispatchEvent(new CustomEvent(WEBVIEW_LAYOUT_CHANGED_EVENT));
  });
}

export function dispatchWebviewNativeFrameUpdated(label: string): void {
  window.dispatchEvent(
    new CustomEvent<WebviewNativeFrameUpdatedDetail>(
      WEBVIEW_NATIVE_FRAME_UPDATED_EVENT,
      { detail: { label } }
    )
  );
}
