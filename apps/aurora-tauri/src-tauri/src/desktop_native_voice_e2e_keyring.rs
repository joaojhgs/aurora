use keyring::credential::{
    Credential, CredentialApi, CredentialBuilder, CredentialBuilderApi, CredentialPersistence,
};
use keyring::{Error, Result};
use std::any::Any;
use std::collections::HashMap;
use std::fmt;
use std::sync::{Arc, Mutex};

type CredentialKey = (Option<String>, String, String);
type CredentialStore = Arc<Mutex<HashMap<CredentialKey, Vec<u8>>>>;

#[derive(Default)]
struct DesktopNativeVoiceE2eCredentialBuilder {
    store: CredentialStore,
}

struct DesktopNativeVoiceE2eCredential {
    key: CredentialKey,
    store: CredentialStore,
}

pub fn credential_builder() -> Box<CredentialBuilder> {
    Box::new(DesktopNativeVoiceE2eCredentialBuilder::default())
}

impl CredentialBuilderApi for DesktopNativeVoiceE2eCredentialBuilder {
    fn build(&self, target: Option<&str>, service: &str, user: &str) -> Result<Box<Credential>> {
        Ok(Box::new(DesktopNativeVoiceE2eCredential {
            key: (
                target.map(str::to_owned),
                service.to_owned(),
                user.to_owned(),
            ),
            store: Arc::clone(&self.store),
        }))
    }

    fn as_any(&self) -> &dyn Any {
        self
    }

    fn persistence(&self) -> CredentialPersistence {
        CredentialPersistence::ProcessOnly
    }
}

impl CredentialApi for DesktopNativeVoiceE2eCredential {
    fn set_secret(&self, secret: &[u8]) -> Result<()> {
        self.store
            .lock()
            .map_err(|_| storage_failure())?
            .insert(self.key.clone(), secret.to_vec());
        Ok(())
    }

    fn get_secret(&self) -> Result<Vec<u8>> {
        self.store
            .lock()
            .map_err(|_| storage_failure())?
            .get(&self.key)
            .cloned()
            .ok_or(Error::NoEntry)
    }

    fn delete_credential(&self) -> Result<()> {
        let removed = self
            .store
            .lock()
            .map_err(|_| storage_failure())?
            .remove(&self.key);
        removed.map(|_| ()).ok_or(Error::NoEntry)
    }

    fn as_any(&self) -> &dyn Any {
        self
    }

    fn debug_fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("DesktopNativeVoiceE2eCredential")
    }
}

fn storage_failure() -> Error {
    Error::PlatformFailure(Box::new(std::io::Error::other(
        "desktop native voice E2E credential store lock failed",
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credentials_share_process_memory_without_debugging_secret_values() {
        let builder = credential_builder();
        let first = builder
            .build(None, "dev.aurora.desktop.secure-storage", "profile")
            .expect("first credential");
        let second = builder
            .build(None, "dev.aurora.desktop.secure-storage", "profile")
            .expect("second credential");

        assert!(matches!(first.get_password(), Err(Error::NoEntry)));
        first
            .set_password("bounded-fixture")
            .expect("store fixture");
        assert!(matches!(
            second.get_password().as_deref(),
            Ok("bounded-fixture")
        ));
        assert_eq!(format!("{second:?}"), "DesktopNativeVoiceE2eCredential");
        second.delete_credential().expect("delete fixture");
        assert!(matches!(first.get_password(), Err(Error::NoEntry)));
    }
}
