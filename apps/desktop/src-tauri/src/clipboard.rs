//! The clipboard's picture, for the composer. The window's engine (WebKitGTK) gives a page nothing for a
//! copied picture in its paste event, so the window reads the picture itself, through GTK's clipboard,
//! which works on X11 and on Wayland. Only the app's own pages may call the command (see `capabilities/`).

use tauri::ipc::Response;
use tauri::AppHandle;

/// The clipboard's picture as PNG bytes. Empty when the clipboard holds no picture.
#[tauri::command]
pub async fn read_clipboard_png(app: AppHandle) -> Result<Response, String> {
    // GTK's clipboard is used on the GTK main thread only, so the read runs there and its answer comes back here.
    let (answer, received) = std::sync::mpsc::channel();
    app.run_on_main_thread(move || {
        // Once the window is gone nobody waits for the answer, so a failed send is not an error.
        let _ = answer.send(read_on_main_thread());
    })
    .map_err(|error| error.to_string())?;
    let read = tauri::async_runtime::spawn_blocking(move || received.recv())
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())?;
    Ok(Response::new(read?))
}

/// Reads the clipboard's picture as PNG bytes. Runs on the GTK main thread.
fn read_on_main_thread() -> Result<Vec<u8>, String> {
    let clipboard = gtk::Clipboard::get(&gtk::gdk::SELECTION_CLIPBOARD);
    match clipboard.wait_for_image() {
        Some(picture) => picture
            .save_to_bufferv("png", &[])
            .map_err(|error| error.to_string()),
        None => Ok(Vec::new()),
    }
}
