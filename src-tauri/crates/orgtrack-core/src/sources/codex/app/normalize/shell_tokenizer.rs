//! Quote-aware shell tokenization shared by the read and exploration parsers.

pub(super) fn shell_tokens(command: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut chars = command.chars().peekable();

    while let Some(ch) = chars.next() {
        if let Some(active_quote) = quote {
            if ch == active_quote {
                quote = None;
            } else if ch == '\\' && active_quote == '"' {
                if let Some(next) = chars.next() {
                    current.push(next);
                }
            } else {
                current.push(ch);
            }
            continue;
        }

        match ch {
            '\'' | '"' => quote = Some(ch),
            '&' if chars.peek() == Some(&'&') => {
                chars.next();
                push_shell_token(&mut tokens, &mut current);
                tokens.push("&&".to_string());
            }
            '|' if chars.peek() == Some(&'|') => {
                chars.next();
                push_shell_token(&mut tokens, &mut current);
                tokens.push("||".to_string());
            }
            ';' | '|' => {
                push_shell_token(&mut tokens, &mut current);
                tokens.push(ch.to_string());
            }
            ch if ch.is_whitespace() => push_shell_token(&mut tokens, &mut current),
            '\\' => {
                if let Some(next) = chars.next() {
                    current.push(next);
                }
            }
            _ => current.push(ch),
        }
    }

    push_shell_token(&mut tokens, &mut current);
    tokens
}

fn push_shell_token(tokens: &mut Vec<String>, current: &mut String) {
    if current.is_empty() {
        return;
    }
    tokens.push(std::mem::take(current));
}

pub(super) fn is_shell_separator(token: &str) -> bool {
    matches!(token, "&&" | "||" | ";" | "|")
}
