//! Provider-neutral conversation checkpoints.
//!
//! This leaf crate defines a portable, versioned conversation model and the
//! fail-closed projection boundary for exact source readers. It contains no
//! provider adapters and makes no assumption about the request surface,
//! transport, native profile path, or target runtime format.

mod canonical;
mod exact_reader;
mod model;
mod projection;

pub use exact_reader::*;
pub use model::*;
pub use projection::project_exact_read;

#[cfg(test)]
mod exact_tests;
