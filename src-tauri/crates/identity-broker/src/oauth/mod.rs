mod pkce;

use crate::{
    HostedServiceOAuthConfig, Org2CloudOAuthConfig, SecretBytes, SignInFlowPhase, SignInFlowView,
};

pub(crate) const ORG2_CLOUD_FLOW_TTL_SECS: i64 = 5 * 60;
pub(crate) const ORG2_CLOUD_CALLBACK_PATH: &str = "/org2-cloud/oauth/callback";

pub(crate) struct PendingSignInFlow {
    pub flow_id: String,
    pub phase: SignInFlowPhase,
    pub generation: u64,
    pub state: String,
    pub verifier: Option<SecretBytes>,
    pub config: Org2CloudOAuthConfig,
    pub loopback_port: u16,
    pub created_at_unix: i64,
}

pub(crate) struct PendingHostedSignInFlow {
    pub flow_id: String,
    pub phase: SignInFlowPhase,
    pub generation: u64,
    pub verifier: Option<SecretBytes>,
    pub config: HostedServiceOAuthConfig,
    pub created_at_unix: i64,
}

impl PendingHostedSignInFlow {
    pub(crate) fn view(&self) -> SignInFlowView {
        SignInFlowView {
            flow_id: self.flow_id.clone(),
            realm: crate::IdentityRealm::HostedServiceLegacy,
            phase: self.phase,
            generation: self.generation,
        }
    }
}

impl PendingSignInFlow {
    pub(crate) fn view(&self) -> SignInFlowView {
        SignInFlowView {
            flow_id: self.flow_id.clone(),
            realm: crate::IdentityRealm::Org2Cloud,
            phase: self.phase,
            generation: self.generation,
        }
    }
}

/// One-shot secret-bearing request assembled only after callback validation.
/// It is consumed by the native adapter and never crosses serialization.
pub struct OAuthCodeExchange {
    flow_id: String,
    generation: u64,
    code: SecretBytes,
    verifier: SecretBytes,
    config: Org2CloudOAuthConfig,
}

impl OAuthCodeExchange {
    pub(crate) fn new(
        flow_id: String,
        generation: u64,
        code: SecretBytes,
        verifier: SecretBytes,
        config: Org2CloudOAuthConfig,
    ) -> Self {
        Self {
            flow_id,
            generation,
            code,
            verifier,
            config,
        }
    }

    pub fn flow_id(&self) -> &str {
        &self.flow_id
    }

    pub fn generation(&self) -> u64 {
        self.generation
    }

    pub fn code(&self) -> &[u8] {
        self.code.expose()
    }

    pub fn verifier(&self) -> &[u8] {
        self.verifier.expose()
    }

    pub fn config(&self) -> &Org2CloudOAuthConfig {
        &self.config
    }
}

/// One-shot Hosted PKCE exchange. The renderer submits only the authorization
/// code; the verifier and endpoint tuple remain native-owned.
pub struct HostedOAuthCodeExchange {
    flow_id: String,
    generation: u64,
    code: SecretBytes,
    verifier: SecretBytes,
    config: HostedServiceOAuthConfig,
}

impl HostedOAuthCodeExchange {
    pub(crate) fn new(
        flow_id: String,
        generation: u64,
        code: SecretBytes,
        verifier: SecretBytes,
        config: HostedServiceOAuthConfig,
    ) -> Self {
        Self {
            flow_id,
            generation,
            code,
            verifier,
            config,
        }
    }

    pub fn flow_id(&self) -> &str {
        &self.flow_id
    }

    pub fn generation(&self) -> u64 {
        self.generation
    }

    pub fn code(&self) -> &[u8] {
        self.code.expose()
    }

    pub fn verifier(&self) -> &[u8] {
        self.verifier.expose()
    }

    pub fn config(&self) -> &HostedServiceOAuthConfig {
        &self.config
    }
}

pub(crate) use pkce::create_pkce_material;
