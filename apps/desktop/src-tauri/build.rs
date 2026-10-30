fn main() {
    // Only the commands listed here get a permission; a capability then grants one of them to a window.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "read_clipboard_png",
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
