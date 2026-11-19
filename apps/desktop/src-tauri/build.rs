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
            "rename_server",
            "forget_server",
            "check_server",
            "notify",
            "new_window",
            // Agent access (#20), for the server's pages in the side bar's panel (server.rs PAGE_PERMISSIONS; each
            // acts only for a window showing the server this computer is linked to, see access.rs).
            "access_here",
            "access_set_up_here",
            "access_status",
            "access_on",
            "access_off",
            "access_acknowledge",
            "access_extend",
            "access_sudo",
            "access_events",
            "access_remove",
        ]),
    ))
    .unwrap();
}
