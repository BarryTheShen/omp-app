//! The clipboard's picture and files, for the composer. The window's engine (WebKitGTK) gives a page nothing for a
//! copied picture in its paste event, and a file a file manager copied may come as its path alone, so the window reads
//! them itself, through GTK's clipboard, which works on X11 and on Wayland. Only the app's own pages may call the
//! commands (see `capabilities/`), and a page reads only the files the person copied, by their place in the clipboard's
//! list.

use std::path::PathBuf;

use serde_json::{json, Value};
use tauri::ipc::Response;
use tauri::AppHandle;

/// The largest file the window reads for a page: the server's upload limit, as the composer's `MAX_FILE_BYTES`.
const MAX_FILE_BYTES: u64 = 100 * 1024 * 1024;

/// The clipboard's picture as PNG bytes. Empty when the clipboard holds no picture.
#[tauri::command]
pub async fn read_clipboard_png(app: AppHandle) -> Result<Response, String> {
    Ok(Response::new(on_main_thread(&app, read_png).await??))
}

/// The files a file manager copied (#2833), each as `{ "name", "size" }` in the clipboard's order; files only, no
/// folders. Empty when the clipboard holds none.
#[tauri::command]
pub async fn list_clipboard_files(app: AppHandle) -> Result<Value, String> {
    let files = on_main_thread(&app, copied_files).await?;
    Ok(Value::Array(
        files
            .iter()
            .map(|path| {
                let name = path
                    .file_name()
                    .map(|name| name.to_string_lossy().into_owned())
                    .unwrap_or_default();
                let size = std::fs::metadata(path).map(|meta| meta.len()).unwrap_or(0);
                json!({ "name": name, "size": size })
            })
            .collect(),
    ))
}

/// The bytes of the copied file at `index` in `list_clipboard_files`. The clipboard is read again: a file it no longer
/// holds, or one larger than `MAX_FILE_BYTES`, is refused with the reason.
#[tauri::command]
pub async fn read_clipboard_file(app: AppHandle, index: usize) -> Result<Response, String> {
    let files = on_main_thread(&app, copied_files).await?;
    let path = files
        .into_iter()
        .nth(index)
        .ok_or("The clipboard no longer holds that file.")?;
    let size = std::fs::metadata(&path)
        .map_err(|error| error.to_string())?
        .len();
    if size > MAX_FILE_BYTES {
        return Err(format!(
            "{} is larger than 100 MB.",
            path.file_name().unwrap_or_default().to_string_lossy()
        ));
    }
    let bytes = tauri::async_runtime::spawn_blocking(move || std::fs::read(path))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())?;
    Ok(Response::new(bytes))
}

/// Runs `read` on the GTK main thread, where GTK's clipboard is used, and hands its answer back here.
async fn on_main_thread<T: Send + 'static>(
    app: &AppHandle,
    read: impl FnOnce() -> T + Send + 'static,
) -> Result<T, String> {
    let (answer, received) = std::sync::mpsc::channel();
    app.run_on_main_thread(move || {
        // Once the window is gone nobody waits for the answer, so a failed send is not an error.
        let _ = answer.send(read());
    })
    .map_err(|error| error.to_string())?;
    tauri::async_runtime::spawn_blocking(move || received.recv())
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())
}

/// Reads the clipboard's picture as PNG bytes. Runs on the GTK main thread.
fn read_png() -> Result<Vec<u8>, String> {
    let clipboard = gtk::Clipboard::get(&gtk::gdk::SELECTION_CLIPBOARD);
    match clipboard.wait_for_image() {
        Some(picture) => picture
            .save_to_bufferv("png", &[])
            .map_err(|error| error.to_string()),
        None => Ok(Vec::new()),
    }
}

/// The local files on the clipboard (its `text/uri-list`), folders and other addresses left out. Runs on the GTK main
/// thread.
fn copied_files() -> Vec<PathBuf> {
    let clipboard = gtk::Clipboard::get(&gtk::gdk::SELECTION_CLIPBOARD);
    clipboard
        .wait_for_uris()
        .iter()
        .filter_map(|uri| gtk::glib::filename_from_uri(uri).ok())
        .map(|(path, _host)| path)
        .filter(|path| path.is_file())
        .collect()
}
