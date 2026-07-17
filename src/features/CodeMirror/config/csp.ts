import { EditorView } from "@codemirror/view";

import { CODEMIRROR_STYLE_NONCE } from "./nonce";

export const codeMirrorCspNonceExtension = EditorView.cspNonce.of(
  CODEMIRROR_STYLE_NONCE
);
