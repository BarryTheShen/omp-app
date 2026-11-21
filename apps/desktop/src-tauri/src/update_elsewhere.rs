//! Updating the desktop app off Linux: Linux builds install the release's `.deb` (see `update.rs`); each release also
//! carries the macOS `.dmg` and the Windows installer (release.yml, desktop-other), which this build does not yet install
//! itself, so the button's command names the file for this system to download and open.

use tauri::AppHandle;

/// The release's file of the window for this system, as `packaging/build-desktop-bundle.sh` names it.
fn bundle_name(version: &str) -> String {
    if cfg!(windows) {
        format!("omp-app-desktop_{version}_x64-setup.exe")
    } else {
        format!("omp-app-desktop_{version}_aarch64.dmg")
    }
}

/// Says, in words for the page, where this system's new version is.
#[tauri::command]
pub async fn update_desktop_app(_app: AppHandle, version: String) -> Result<(), String> {
    Err(format!(
        "This app does not install updates itself on this computer yet. Download and open https://github.com/BarryTheShen/omp-app/releases/download/v{version}/{}.",
        bundle_name(&version)
    ))
}
