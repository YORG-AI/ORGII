//! Used only by scripts/verification/harness-connection-cli.py in an isolated HOME.
fn main() -> Result<(), String> {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 3
        || !args[2].starts_with("http://127.0.0.1:")
        || std::env::var_os("ORGII_EXTERNAL_HISTORY_HOME").is_none()
    {
        return Err("Fixture requires an isolated config root and a loopback endpoint".into());
    }
    agent_cli::managed_config::enable_direct(
        &args[1],
        agent_cli::managed_config::DirectConnection {
            key_id: "fixture".into(),
            provider: "custom_api".into(),
            model: "fixture-model".into(),
            base_url: args[2].clone(),
            api_key: "orgii-fixture-key".into(),
        },
        None,
    )?;
    Ok(())
}
