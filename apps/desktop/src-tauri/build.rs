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
            "open_server_window",
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
            "access_allow_folder",
            "access_deny_folder",
            "access_remove_folder",
            "access_allow_chat",
            "access_deny_chat",
            "access_remove_chat",
            "access_add_chat",
            "access_share_folder",
            // Settings → App → omp-app → Update this app (update.rs).
            "update_desktop_app",
            // Your own browser from this computer, carried to the window's server (relay.rs).
            "relay_carry",
            "relay_state",
            "relay_stop",
        ]),
    ))
    .unwrap();
}
