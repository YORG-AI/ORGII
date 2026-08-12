//! Short aliases used inside category tables so entries stay terse but the
//! enum variants remain unambiguous at a glance.

pub(super) use super::super::super::categories as tool_categories;
pub(super) use super::super::super::names as tool_names;
pub(super) use super::super::super::ui_metadata::{
    AppSubtool, ChatBlock, HumanToolKey, SimulatorApp, ToolDisplayBehavior,
};
pub(super) use super::super::types::{ActionEntry, ToolEntry, DEFAULT_TOOL_ENTRY};
pub(super) use crate::definitions::capabilities::RequiredCapability;

pub(super) use AppSubtool::{
    Browser as SubBrowser, Explore, FileRead, FileWrite, Glob as SubGlob,
    InternalBrowser as SubInternalBrowser, Message, OtherInteractions, OtherTool,
    Search as SubSearch, Shell, Subagent as SubSubagent, Thinking as SubThinking, Todo as SubTodo,
};
// ChatBlock aliases — one per actual React block component.
pub(super) use ChatBlock::{
    CanvasInline as CbCanvasInline, Diff as CbDiff, Explore as CbExplore, Fallback as CbFallback,
    Glob as CbGlob, OrgTask as CbOrgTask, PlanDoc as CbPlanDoc, ReadFile as CbReadFile,
    Search as CbSearch, SentMessage as CbSentMessage, SetupRepo as CbSetupRepo, Shell as CbShell,
    Subagent as CbSubagent, TitleOnly as CbTitleOnly, Todo as CbTodo, WebSearch as CbWebSearch,
};
pub(super) use HumanToolKey::{
    Browser as HtBrowser,
    CodeEditor as HtCode,
    Sessions,
    Terminal,
    // `App as HtApp` — re-add alongside the `control_orgii` entry when the
    // cowork / voice GUI tool is re-enabled.
};
pub(super) use SimulatorApp::{
    BackgroundTasks as AppBackgroundTasks, Browser as AppBrowser, Canvas as AppCanvas,
    Channels as AppChannels, CodeEditor as AppCode,
};
pub(super) use ToolDisplayBehavior::{
    Instant as DisplayInstant, Stream as DisplayStream, WaitForResult as DisplayWaitForResult,
};
// RequiredCapability aliases — one per action group.
// `Core` is the DEFAULT_TOOL_ENTRY default so it's never spelled out explicitly.
pub(super) use RequiredCapability::{
    BrowserExternal as CapBrowserExt, BrowserInternal as CapBrowserInt, Coding as CapCoding,
    Data as CapData, Desktop as CapDesktop, Gateway as CapGateway, Management as CapManagement,
    Orchestration as CapOrch,
};
