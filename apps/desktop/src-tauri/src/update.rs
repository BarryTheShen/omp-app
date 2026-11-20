//! Settings → App → omp-app → Update this app: the desktop app installs a newer release of itself. It downloads the
//! release's package and checksums from omp-app's releases, checks the package, and installs it through `pkexec`, so
//! Ubuntu asks the person's password: only because they pressed Update, never on its own. Then the computer's agent
//! (`omp-app-device`, in the same package) restarts, and so does the app. Only a newer release than this one installs,
//! so a page can never move the app back.
use std::path::{Path, PathBuf};
use std::process::Command;

use tauri::{AppHandle, Manager};

const RELEASES: &str = "https://github.com/BarryTheShen/omp-app/releases";

/// The three numbers of a version (`0.3.1684`); None for anything else.
fn numbers(version: &str) -> Option<[u64; 3]> {
    let mut parts = version.split('.').map(|part| {
        if !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()) {
            part.parse::<u64>().ok()
        } else {
            None
        }
    });
    let found = [parts.next()??, parts.next()??, parts.next()??];
    parts.next().is_none().then_some(found)
}

/// Whether `wanted` is a newer release than `running` (both three numbers).
fn is_newer(wanted: &str, running: &str) -> bool {
    matches!((numbers(wanted), numbers(running)), (Some(a), Some(b)) if a > b)
}

/// The checksum `SHA256SUMS` gives for `name`.
fn sum_for(sums: &str, name: &str) -> Option<String> {
    sums.lines().find_map(|line| {
        let mut fields = line.split_whitespace();
        let sum = fields.next()?;
        (fields.next()?.trim_start_matches('*') == name).then(|| sum.to_lowercase())
    })
}

fn run(command: &mut Command, what: &str) -> Result<String, String> {
    let output = command.output().map_err(|error| format!("{what} could not start: {error}"))?;
    if output.status.success() {
        return Ok(String::from_utf8_lossy(&output.stdout).into_owned());
    }
    let said = String::from_utf8_lossy(&output.stderr);
    Err(match output.status.code() {
        // pkexec: the password dialog was dismissed, or the password was not accepted.
        Some(126) | Some(127) if what == "the install" => "the password was not given".to_string(),
        _ => format!("{what} failed: {}", said.trim().lines().last().unwrap_or("no message")),
    })
}

fn download(url: &str, to: &Path) -> Result<(), String> {
    run(
        Command::new("curl").args(["-fsSL", "--max-time", "600", "-o"]).arg(to).arg(url),
        &format!("downloading {url}"),
    )
    .map(|_| ())
}

/// Downloads, checks and installs the desktop package of `version` into `folder`.
fn install(version: &str, folder: &Path) -> Result<(), String> {
    std::fs::create_dir_all(folder).map_err(|error| format!("{}: {error}", folder.display()))?;
    let name = format!("omp-app-desktop_{version}_amd64.deb");
    let sums = folder.join("SHA256SUMS");
    let deb = folder.join(&name);
    download(&format!("{RELEASES}/download/v{version}/SHA256SUMS"), &sums)?;
    let text = std::fs::read_to_string(&sums).map_err(|error| error.to_string())?;
    let expected = sum_for(&text, &name).ok_or(format!("the release lists no checksum for {name}"))?;
    download(&format!("{RELEASES}/download/v{version}/{name}"), &deb)?;
    let actual = run(Command::new("sha256sum").arg(&deb), "checking the package")?;
    if actual.split_whitespace().next() != Some(expected.as_str()) {
        let _ = std::fs::remove_file(&deb);
        return Err(format!("the downloaded {name} does not match the release's checksum: nothing was installed"));
    }
    run(
        Command::new("pkexec")
            .args(["env", "DEBIAN_FRONTEND=noninteractive", "apt-get", "install", "-y", "-q"])
            .arg(&deb),
        "the install",
    )?;
    Ok(())
}

/// Installs a newer release of the desktop app, then restarts the computer's agent and the app. Errors are said in
/// words for the page; on success the app ends here and starts again.
#[tauri::command]
pub async fn update_desktop_app(app: AppHandle, version: String) -> Result<(), String> {
    let running = app.package_info().version.to_string();
    if !is_newer(&version, &running) {
        return Err(format!("{version} is not newer than this desktop app ({running})"));
    }
    let folder: PathBuf = app
        .path()
        .app_cache_dir()
        .map_err(|error| error.to_string())?
        .join("updates")
        .join(format!("v{version}"));
    let wanted = version.clone();
    tauri::async_runtime::spawn_blocking(move || install(&wanted, &folder))
        .await
        .map_err(|error| error.to_string())??;
    // The agent is in the same package: it moves to the new release now, not at the next login.
    let _ = Command::new("systemctl").args(["--user", "restart", "omp-app-device"]).status();
    // The app starts again from its launcher a moment after this one ends (a new process group, so it outlives this).
    use std::os::unix::process::CommandExt;
    let _ = Command::new("sh")
        .args(["-c", "sleep 2; exec gtk-launch omp-app-desktop"])
        .process_group(0)
        .spawn();
    app.exit(0);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_newer_release_by_number_installs() {
        assert!(is_newer("0.3.1700", "0.3.1684"));
        assert!(is_newer("0.4.0", "0.3.1684"));
        assert!(!is_newer("0.3.999", "0.3.1684"));
        assert!(!is_newer("0.3.1684", "0.3.1684"));
        assert!(!is_newer("0.3.1700; rm -rf ~", "0.3.1684"));
        assert!(!is_newer("0.3", "0.3.1684"));
        assert!(!is_newer("0.3.1700.1", "0.3.1684"));
    }

    #[test]
    fn the_checksum_is_the_one_listed_for_the_package() {
        let sums = "aaa  omp-app_0.3.1700_amd64.deb\nBBB *omp-app-desktop_0.3.1700_amd64.deb\n";
        assert_eq!(sum_for(sums, "omp-app-desktop_0.3.1700_amd64.deb").as_deref(), Some("bbb"));
        assert_eq!(sum_for(sums, "omp-app-desktop_0.3.1699_amd64.deb"), None);
    }
}
