//! Capability-gated language features: definition, references, hover,
//! and the document / workspace symbol requests.

use std::time::Duration;

use super::super::types::*;
use super::helpers::parse_uri;
use super::lifecycle::LspServer;

impl LspServer {
    /// Request textDocument/definition (go-to-definition).
    ///
    /// `Ok(None)` means the server replied but had no definition for the
    /// position (`null` result), which is distinct from an error.
    pub async fn goto_definition(
        &self,
        uri: &str,
        line: u32,
        character: u32,
    ) -> Result<Option<GotoDefinitionResponse>, String> {
        self.require_capability(|c| c.supports_definition(), "definition")
            .await?;
        let params = GotoDefinitionParams {
            text_document_position_params: TextDocumentPositionParams {
                text_document: TextDocumentIdentifier {
                    uri: parse_uri(uri)?,
                },
                position: Position { line, character },
            },
            work_done_progress_params: Default::default(),
            partial_result_params: Default::default(),
        };
        self.send_typed_request("textDocument/definition", &params, Duration::from_secs(10))
            .await
    }

    /// Request textDocument/references (find all references).
    ///
    /// `Ok(None)` means the server replied with `null`; `Ok(Some(vec))`
    /// is the (possibly empty) list of references.
    pub async fn find_references(
        &self,
        uri: &str,
        line: u32,
        character: u32,
        include_declaration: bool,
    ) -> Result<Option<Vec<Location>>, String> {
        self.require_capability(|c| c.supports_references(), "references")
            .await?;
        let params = ReferenceParams {
            text_document_position: TextDocumentPositionParams {
                text_document: TextDocumentIdentifier {
                    uri: parse_uri(uri)?,
                },
                position: Position { line, character },
            },
            context: ReferenceContext {
                include_declaration,
            },
            work_done_progress_params: Default::default(),
            partial_result_params: Default::default(),
        };
        self.send_typed_request("textDocument/references", &params, Duration::from_secs(15))
            .await
    }

    /// Request textDocument/hover (type/doc info at position).
    ///
    /// `Ok(None)` means no hover info at that position.
    pub async fn hover(
        &self,
        uri: &str,
        line: u32,
        character: u32,
    ) -> Result<Option<Hover>, String> {
        self.require_capability(|c| c.supports_hover(), "hover")
            .await?;
        let params = HoverParams {
            text_document_position_params: TextDocumentPositionParams {
                text_document: TextDocumentIdentifier {
                    uri: parse_uri(uri)?,
                },
                position: Position { line, character },
            },
            work_done_progress_params: Default::default(),
        };
        self.send_typed_request("textDocument/hover", &params, Duration::from_secs(10))
            .await
    }

    /// Request textDocument/documentSymbol for a synced file.
    pub async fn document_symbol(
        &self,
        uri: &str,
    ) -> Result<Option<DocumentSymbolResponse>, String> {
        self.require_capability(|c| c.supports_document_symbol(), "document symbols")
            .await?;
        let params = DocumentSymbolParams {
            text_document: TextDocumentIdentifier {
                uri: parse_uri(uri)?,
            },
            work_done_progress_params: Default::default(),
            partial_result_params: Default::default(),
        };
        self.send_typed_request(
            "textDocument/documentSymbol",
            &params,
            Duration::from_secs(15),
        )
        .await
    }

    /// Request workspace/symbol for the initialized workspace.
    pub async fn workspace_symbol(
        &self,
        query: &str,
    ) -> Result<Option<WorkspaceSymbolResponse>, String> {
        self.require_capability(|c| c.supports_workspace_symbol(), "workspace symbols")
            .await?;
        let params = WorkspaceSymbolParams {
            partial_result_params: Default::default(),
            work_done_progress_params: Default::default(),
            query: query.to_string(),
        };
        self.send_typed_request("workspace/symbol", &params, Duration::from_secs(15))
            .await
    }

    /// Returns `Ok(())` if `predicate` holds on the cached
    /// `ServerCapabilities`. Returns `Err` if the capability is missing,
    /// so the caller can short-circuit before sending a request the
    /// server cannot answer.
    ///
    /// If `initialize` somehow ran without storing capabilities (e.g.
    /// a server returned a malformed `result`), we degrade open
    /// rather than refusing service — `request_with_timeout` will
    /// surface any `MethodNotFound` JSON-RPC error from the server.
    async fn require_capability<F>(&self, predicate: F, feature: &'static str) -> Result<(), String>
    where
        F: Fn(&ServerCapabilities) -> bool,
    {
        let guard = self.capabilities.read().await;
        match guard.as_ref() {
            Some(caps) if !predicate(caps) => Err(format!(
                "{} server does not advertise '{}' capability",
                self.language, feature
            )),
            _ => Ok(()),
        }
    }
}
