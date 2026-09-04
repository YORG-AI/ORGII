use orgii_mobile_relay::config::RelayConfig;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "orgii_mobile_relay=info,tower_http=info".into()),
        )
        .init();

    let config = RelayConfig::from_env().unwrap_or_else(|message| {
        eprintln!("mobile relay configuration error: {message}");
        std::process::exit(2);
    });
    if let Err(message) = orgii_mobile_relay::serve(config).await {
        eprintln!("mobile relay stopped: {message}");
        std::process::exit(1);
    }
}
