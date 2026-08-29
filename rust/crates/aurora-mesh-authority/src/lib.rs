//! Mesh peer authority core.
//!
//! The Rust home of what `packages/aurora-sdk/src/peer-host/` decides: grants,
//! permission evaluation, execution policy, and the denial paths. Per the R0
//! boundary note (`docs/mesh/NATIVE-TYPESCRIPT-BOUNDARY.md`) this crate is the
//! *authority store* and nothing else — it is keyed by peer identity, holds no
//! transport state, and never learns which connection a peer arrived on. The
//! session registry stays in TypeScript.
//!
//! Two authorities would be drift in the one layer where drift is a
//! vulnerability, so the TypeScript implementation is deleted once this one
//! reaches parity against the shared fixture corpus rather than kept as a
//! second opinion.

pub mod authority;
pub mod authorization;
pub mod contract_registry;
pub mod crypto;
pub mod grant_management;
pub mod types;

#[cfg(target_arch = "wasm32")]
pub mod wasm;
