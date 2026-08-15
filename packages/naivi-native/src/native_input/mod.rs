//! Platform native text-input backends for the naivi native host.

#[cfg(target_os = "macos")]
mod macos;

#[cfg(target_os = "macos")]
pub use macos::{MacOSNativeTextInput, set_proxy};
