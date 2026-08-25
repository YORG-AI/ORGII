use std::error::Error;
use std::fmt::{Display, Formatter};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NativeMaterializationFailureKind {
    AcceptanceFailed,
    FilesystemBoundary,
    InvalidRequest,
    NativeParityMismatch,
    NoClobber,
    UnsupportedPlatform,
    UnsupportedPortableSemantics,
    UnsupportedRuntimeVersion,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeMaterializationError {
    pub kind: NativeMaterializationFailureKind,
    pub message: String,
}

impl NativeMaterializationError {
    pub(crate) fn new(kind: NativeMaterializationFailureKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }

    pub(crate) fn invalid(message: impl Into<String>) -> Self {
        Self::new(NativeMaterializationFailureKind::InvalidRequest, message)
    }

    pub(crate) fn unsupported_semantics(message: impl Into<String>) -> Self {
        Self::new(
            NativeMaterializationFailureKind::UnsupportedPortableSemantics,
            message,
        )
    }

    pub(crate) fn parity(message: impl Into<String>) -> Self {
        Self::new(
            NativeMaterializationFailureKind::NativeParityMismatch,
            message,
        )
    }

    pub(crate) fn filesystem(message: impl Into<String>) -> Self {
        Self::new(
            NativeMaterializationFailureKind::FilesystemBoundary,
            message,
        )
    }
}

impl Display for NativeMaterializationError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl Error for NativeMaterializationError {}

pub type NativeMaterializationResult<T> = Result<T, NativeMaterializationError>;
