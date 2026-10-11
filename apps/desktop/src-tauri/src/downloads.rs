//! Where a download the web app asks for is saved. The web app saves its debug log as a download, and it
//! says "to your downloads", so the window puts it in the account's Downloads folder: the one the account
//! sets in `~/.config/user-dirs.dirs`, or `$HOME/Downloads` (the XDG default) when that setting is missing.
//! The default the webview would use is the folder the window was started from, which is not where a person
//! looks for a download.

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};

/// The folder downloads go into: `xdg` (the account's Downloads folder) when the account sets one, else
/// `home/Downloads`. None when neither is known.
pub fn download_folder(xdg: Option<PathBuf>, home: Option<PathBuf>) -> Option<PathBuf> {
    xdg.or_else(|| home.map(|home| home.join("Downloads")))
}

/// A path in `folder` for a download named `name` that is not taken yet: `name` itself, then
/// `stem (2).ext`, `stem (3).ext`, and so on, the way a browser names a second download of one file.
pub fn unique_path(folder: &Path, name: &OsStr, taken: impl Fn(&Path) -> bool) -> PathBuf {
    let mut candidate = folder.join(name);
    let file = Path::new(name);
    let mut number = 1;
    while taken(&candidate) {
        number += 1;
        let mut renamed: OsString = file.file_stem().unwrap_or(name).to_os_string();
        renamed.push(format!(" ({number})"));
        if let Some(extension) = file.extension() {
            renamed.push(".");
            renamed.push(extension);
        }
        candidate = folder.join(renamed);
    }
    candidate
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_account_download_folder_is_used_when_the_account_sets_one() {
        assert_eq!(
            download_folder(Some("/data/Descargas".into()), Some("/home/a".into())),
            Some(PathBuf::from("/data/Descargas"))
        );
    }

    #[test]
    fn without_the_setting_the_home_folders_downloads_folder_is_used() {
        assert_eq!(
            download_folder(None, Some("/home/a".into())),
            Some(PathBuf::from("/home/a/Downloads"))
        );
    }

    #[test]
    fn without_a_home_folder_there_is_no_folder() {
        assert_eq!(download_folder(None, None), None);
    }

    #[test]
    fn a_free_name_is_kept_and_a_taken_one_is_numbered_before_its_extension() {
        let folder = Path::new("/home/a/Downloads");
        assert_eq!(
            unique_path(folder, OsStr::new("debug.log"), |_| false),
            folder.join("debug.log")
        );
        let taken = [folder.join("debug.log"), folder.join("debug (2).log")];
        assert_eq!(
            unique_path(folder, OsStr::new("debug.log"), |path| taken
                .contains(&path.to_path_buf())),
            folder.join("debug (3).log")
        );
    }

    #[test]
    fn a_name_without_an_extension_is_numbered_at_its_end() {
        let folder = Path::new("/home/a/Downloads");
        let taken = [folder.join("report")];
        assert_eq!(
            unique_path(folder, OsStr::new("report"), |path| taken
                .contains(&path.to_path_buf())),
            folder.join("report (2)")
        );
    }
}
