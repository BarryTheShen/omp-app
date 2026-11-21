//! Agent access off Linux: it is built on Linux accounts, sshd and polkit (see `access.rs`, which Linux builds use), so
//! on macOS and Windows each of its commands answers that in words, and the side bar's Agent access panel shows them
//! instead of failing (platforms PLAN, P4). The commands keep their names, so the pages ask the same way everywhere.

use serde_json::Value;
use tauri::AppHandle;

/// What every command answers here.
const ONLY_ON_LINUX: &str = "Agent access works on Linux computers only for now.";

macro_rules! linux_only {
    ($($name:ident),* $(,)?) => {
        $(
            #[tauri::command]
            pub async fn $name() -> Result<Value, String> {
                Err(ONLY_ON_LINUX.to_owned())
            }
        )*
    };
}

linux_only!(
    access_status,
    access_on,
    access_off,
    access_acknowledge,
    access_extend,
    access_sudo,
    access_events,
    access_remove,
    access_allow_folder,
    access_deny_folder,
    access_remove_folder,
    access_allow_chat,
    access_deny_chat,
    access_remove_chat,
    access_here,
    access_set_up_here,
);

/// Nothing to watch: no access can be on here.
pub fn watch(_app: AppHandle) {}
