//! The microphone for voice input (V259) in the Linux window. WebKitGTK keeps media streams off, and refuses a page's
//! request for the microphone unless the app answers it. The window shows the app's own pages (this computer's server,
//! or a paired server's), so a request for the microphone alone is allowed; one that wants a camera is refused.

use tauri::WebviewWindow;
use webkit2gtk::glib::prelude::Cast;
use webkit2gtk::{
    PermissionRequestExt, SettingsExt, UserMediaPermissionRequest, UserMediaPermissionRequestExt,
    WebViewExt,
};

/// Turns on media streams in `window`'s webview and allows its pages the microphone. A window whose webview cannot be
/// reached says so in the log; voice input then says the microphone could not start.
pub fn allow_microphone(window: &WebviewWindow) {
    let installed = window.with_webview(|webview| {
        let view = webview.inner();
        if let Some(settings) = WebViewExt::settings(&view) {
            settings.set_enable_media_stream(true);
        }
        view.connect_permission_request(|_, request| {
            let Some(media) = request.downcast_ref::<UserMediaPermissionRequest>() else {
                return false;
            };
            if media.is_for_audio_device() && !media.is_for_video_device() {
                request.allow();
            } else {
                request.deny();
            }
            true
        });
    });
    if let Err(error) = installed {
        eprintln!("omp app: voice input cannot use the microphone: {error}");
    }
}
