//! The windows' web data (their pages' storage and cookies) in a folder of the app's own. A server pairs the window as
//! a device with a key kept in a cookie, and WebKitGTK keeps cookies across starts only in a folder it is given: with
//! none, it keeps them in memory ("By default, cookie_manager doesn't store the cookies persistently",
//! `webkit_cookie_manager_set_persistent_storage`). The first start with the folder copies the pages' storage from
//! the place WebKitGTK used before, so the window keeps its theme, layout and the rest.

use std::ffi::OsStr;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// The pages' storage WebKitGTK keeps under a data folder: localStorage, the older databases (IndexedDB among them), and
/// `storage`, where newer WebKitGTK keeps each site's data under a salted name (the salt file comes along).
const STORAGE: [&str; 3] = ["localstorage", "databases", "storage"];

/// The data folder: `$XDG_DATA_HOME` when that variable is an absolute path, otherwise `$HOME/.local/share`. None
/// without a home.
fn data_home(xdg_data_home: Option<&OsStr>, home: Option<&OsStr>) -> Option<PathBuf> {
    match xdg_data_home {
        Some(path) if Path::new(path).is_absolute() => Some(PathBuf::from(path)),
        _ => {
            let home = home.filter(|name| !name.is_empty())?;
            Some(Path::new(home).join(".local").join("share"))
        }
    }
}

/// The windows' own folder: `<data folder>/omp-app/desktop-window`.
pub fn folder(xdg_data_home: Option<&OsStr>, home: Option<&OsStr>) -> Option<PathBuf> {
    Some(
        data_home(xdg_data_home, home)?
            .join("omp-app")
            .join("desktop-window"),
    )
}

/// Where WebKitGTK may have kept the pages' storage before the window had a folder: `<data folder>/<program name>`,
/// the program name being GLib's when WebKit asked for it (`WebsiteDataStore::defaultBaseDataDirectory`), else
/// `webkitgtk`. Which name GLib gave depends on when GTK set it, so every name the program goes by is a candidate, in
/// this order: `names` (the app's identifier, which the released 0.2.1348 window used, then GLib's program name now,
/// then the executable's file name), then `webkitgtk`, which another program may own and so comes last.
pub fn earlier_folders(
    xdg_data_home: Option<&OsStr>,
    home: Option<&OsStr>,
    names: &[&str],
) -> Vec<PathBuf> {
    let Some(root) = data_home(xdg_data_home, home) else {
        return Vec::new();
    };
    let mut folders: Vec<PathBuf> = Vec::new();
    for name in names.iter().copied().chain(["webkitgtk"]) {
        let candidate = root.join(name);
        if !name.is_empty() && !name.contains('/') && !folders.contains(&candidate) {
            folders.push(candidate);
        }
    }
    folders
}

/// Copies the pages' storage into `to` once, from the first of `from` that holds any: only while `to` holds none of
/// it. The folder it was copied from, if any.
pub fn adopt(from: &[PathBuf], to: &Path) -> io::Result<Option<PathBuf>> {
    if STORAGE.iter().any(|part| to.join(part).exists()) {
        return Ok(None);
    }
    let Some(source) = from
        .iter()
        .find(|folder| STORAGE.iter().any(|part| folder.join(part).is_dir()))
    else {
        return Ok(None);
    };
    for part in STORAGE {
        if source.join(part).is_dir() {
            copy_tree(&source.join(part), &to.join(part))?;
        }
    }
    Ok(Some(source.clone()))
}

fn copy_tree(from: &Path, to: &Path) -> io::Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        let kind = entry.file_type()?;
        if kind.is_dir() {
            copy_tree(&entry.path(), &target)?;
        } else if kind.is_file() {
            fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let folder =
            std::env::temp_dir().join(format!("omp-app-webdata-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&folder);
        fs::create_dir_all(&folder).unwrap();
        folder
    }

    #[test]
    fn the_folders_follow_the_data_folder_rule_and_every_name_of_the_program() {
        let home = Some(OsStr::new("/home/u"));
        assert_eq!(
            folder(Some(OsStr::new("/var/data")), home),
            Some(PathBuf::from("/var/data/omp-app/desktop-window"))
        );
        assert_eq!(
            folder(Some(OsStr::new("relative")), home),
            Some(PathBuf::from("/home/u/.local/share/omp-app/desktop-window")),
            "a relative folder is ignored"
        );
        assert_eq!(folder(None, None), None);
        let share = |name: &str| PathBuf::from("/home/u/.local/share").join(name);
        assert_eq!(
            earlier_folders(
                None,
                home,
                &[
                    "dev.omp-app.desktop",
                    "omp-app-desktop",
                    "omp-app-desktop",
                    "",
                    "a/b"
                ]
            ),
            vec![
                share("dev.omp-app.desktop"),
                share("omp-app-desktop"),
                share("webkitgtk")
            ],
            "in order, once each, WebKit's own name last; nothing that is not a folder name"
        );
        assert_eq!(earlier_folders(None, None, &["x"]), Vec::<PathBuf>::new());
    }

    #[test]
    fn the_pages_storage_is_copied_once_from_the_first_folder_that_holds_it() {
        let root = scratch("adopt");
        let (identifier, program, new) = (
            root.join("identifier"),
            root.join("program"),
            root.join("new"),
        );
        fs::create_dir_all(program.join("localstorage")).unwrap();
        fs::write(program.join("localstorage").join("app.localstorage"), "old").unwrap();
        fs::create_dir_all(identifier.join("localstorage")).unwrap();
        fs::write(
            identifier.join("localstorage").join("app.localstorage"),
            "theme=dark",
        )
        .unwrap();
        fs::create_dir_all(identifier.join("databases").join("indexeddb").join("v1")).unwrap();
        fs::write(
            identifier
                .join("databases")
                .join("indexeddb")
                .join("v1")
                .join("db"),
            "rows",
        )
        .unwrap();
        fs::write(identifier.join("cookies"), "not storage").unwrap();
        fs::create_dir_all(identifier.join("storage").join("a1b2")).unwrap();
        fs::write(identifier.join("storage").join("salt"), "salt").unwrap();
        fs::write(
            identifier.join("storage").join("a1b2").join("origin"),
            "site",
        )
        .unwrap();
        let candidates = [root.join("missing"), identifier.clone(), program.clone()];

        assert_eq!(adopt(&candidates, &new).unwrap(), Some(identifier.clone()));
        let copied = |path: &[&str]| {
            fs::read_to_string(path.iter().fold(new.clone(), |at, part| at.join(part)))
        };
        assert_eq!(
            copied(&["localstorage", "app.localstorage"]).unwrap(),
            "theme=dark"
        );
        assert_eq!(
            copied(&["databases", "indexeddb", "v1", "db"]).unwrap(),
            "rows"
        );
        assert_eq!(copied(&["storage", "salt"]).unwrap(), "salt");
        assert_eq!(copied(&["storage", "a1b2", "origin"]).unwrap(), "site");
        assert!(!new.join("cookies").exists(), "only the pages' storage");

        // Once the window has storage of its own, an older copy never replaces it.
        fs::write(
            new.join("localstorage").join("app.localstorage"),
            "theme=light",
        )
        .unwrap();
        assert_eq!(adopt(&candidates, &new).unwrap(), None);
        assert_eq!(
            copied(&["localstorage", "app.localstorage"]).unwrap(),
            "theme=light"
        );

        // No folder holds any: nothing to copy.
        assert_eq!(
            adopt(&[root.join("missing")], &root.join("other")).unwrap(),
            None
        );
        fs::remove_dir_all(&root).unwrap();
    }
}
