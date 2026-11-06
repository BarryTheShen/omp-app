fn main() {
    // Only the commands listed here get a permission; a capability then grants one of them to a window.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "read_clipboard_png",
            "list_clipboard_files",
            "read_clipboard_file",
            "servers",
            "connect_server",
            "open_server",
            "use_this_computer",
            "notify",
            "new_window",
        ]),
    ))
    .unwrap();
}
