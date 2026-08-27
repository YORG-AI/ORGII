use crate::context::ExecutionContext;
use crate::envelope::emit_success;

pub fn cmd_context(context: &ExecutionContext) -> i32 {
    emit_success(crate::context::to_wire(context), None, None)
}
