//! Updating the desktop app off Linux: Linux builds install the release's `.deb` (see `update.rs`); the macOS and
//! Windows packages and their installers come with the release work (platforms PLAN, P5). Until then the button's
//! command says where the new version is.

use tauri::AppHandle;

/// Says, in words for the page, that this build updates by downloading the new version.
#[tauri::command]
pub async fn update_desktop_app(_app: AppHandle, version: String) -> Result<(), String> {
    Err(format!(
        "This app updates itself on Linux only for now. Download {version} from https://github.com/BarryTheShen/omp-app/releases."
    ))
}
