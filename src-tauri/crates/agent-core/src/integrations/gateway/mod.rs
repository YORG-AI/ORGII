//! Gateway integration — channel message routing.
//!
//! Handles:
//! - Receiving messages from external channels (Telegram, Feishu, WeCom,
//!   Weixin, Discord, CLI, webhook, ...)
//! - Managing channel lifecycle (connect / disconnect / reconnect)
//! - Delivering messages to an `InboundMessageHandler` (see
//!   `GatewayInboundHandler` in `agent_core::state::commands::channel_handler`)
//!
//! # Architecture
//!
//! ```text
//! External channel (Telegram, Feishu, ...)
//!     ↓
//! ChannelManager (connection manager)
//!     ↓
//! AgentMessageBus (tokio mpsc/broadcast)
//!     ↓
//! GatewayInboundHandler
//!     ├─ slash command? → command handler
//!     ├─ re-inject mark? → dispatch to session in `session_key_override`
//!     └─ binding hit or new chat? → route to OS session per (channel, chat_id)
//!     ↓
//! Target OS session (one per chat, minted lazily on first inbound)
//! ```
//!
//! # Design
//!
//! The gateway is generic channel plumbing, decoupled from any specific
//! agent. Each `(channel, chat_id)` is bound to a dedicated OS session
//! via the `BindingStore`. Idle-reset versioning (`-v{n}`) recycles
//! sessions for transcript hygiene.

pub mod binding;
pub mod browse;
mod channels_ops;
pub mod commands;
pub mod message_merge;
pub mod reset_policy;
mod service;
mod workers;

// Items kept at the `gateway::` surface — checked one by one against
// real call sites. `SessionBinding` is reached only by the binding
// store implementation itself and its tests, so it does not need to be
// flattened.
pub use binding::{BindingStore, SessionKey};
pub use commands::{parse as parse_command, GatewayCommand};
pub use reset_policy::{ResetMode, ResetPolicy};
pub use service::{GatewayService, InboundMessageHandler, InboundProcessorDeps};

pub use crate::channels::ChannelManager;
