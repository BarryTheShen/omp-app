//! Keys with Super in the window. WebKitGTK sets the page's `metaKey` from GTK's Meta modifier only, never from Super,
//! the key with the Windows logo (`modifiersForEvent` in WebKit's `Source/WebKit/Shared/gtk/WebEventFactory.cpp`).
//! The app's pane keys are kitty's and hold Super (Super+Ctrl+Shift+arrow resizes a pane, Super+Ctrl+arrow moves
//! between panes), so in the window they reached the page as Ctrl+Shift+arrow and Ctrl+arrow: a tab switch, or a text
//! selection. The window takes such a key from WebKit and presses it in the page itself, with `metaKey` set.

use gtk::gdk::keys::{constants as keysyms, Key};
use gtk::gdk::ModifierType;
use gtk::glib::Propagation;
use gtk::prelude::WidgetExt;
use tauri::WebviewWindow;

/// The keys the app binds with Super (`apps/ui/src/keys/table.ts`), with the page's `key` and `code` for each. A key
/// that GTK names differently while Shift is held (`{` for `[`) is listed under both names.
const PAGE_KEYS: [(Key, &str, &str); 16] = [
    (keysyms::Left, "ArrowLeft", "ArrowLeft"),
    (keysyms::Right, "ArrowRight", "ArrowRight"),
    (keysyms::Up, "ArrowUp", "ArrowUp"),
    (keysyms::Down, "ArrowDown", "ArrowDown"),
    (keysyms::bracketleft, "[", "BracketLeft"),
    (keysyms::braceleft, "[", "BracketLeft"),
    (keysyms::bracketright, "]", "BracketRight"),
    (keysyms::braceright, "]", "BracketRight"),
    (keysyms::equal, "=", "Equal"),
    (keysyms::plus, "=", "Equal"),
    (keysyms::k, "k", "KeyK"),
    (keysyms::K, "k", "KeyK"),
    (keysyms::slash, "/", "Slash"),
    (keysyms::question, "/", "Slash"),
    (keysyms::comma, ",", "Comma"),
    (keysyms::less, ",", "Comma"),
];

/// A key pressed with Super, as the page gets it: its `key` and `code`, and the other modifiers held with it.
#[derive(Debug, PartialEq, Eq)]
pub struct SuperKey {
    pub key: &'static str,
    pub code: &'static str,
    pub ctrl: bool,
    pub shift: bool,
    pub alt: bool,
}

/// The page's key for `keyval` pressed with the modifiers `state`: when Super is held, WebKit would not report it (no
/// Meta modifier), and the app binds the key with Super. None for every other key, which WebKit handles as usual.
pub fn super_key(keyval: Key, state: ModifierType) -> Option<SuperKey> {
    let held = state.intersects(ModifierType::SUPER_MASK | ModifierType::MOD4_MASK);
    if !held || state.contains(ModifierType::META_MASK) {
        return None;
    }
    let &(_, key, code) = PAGE_KEYS.iter().find(|(each, _, _)| *each == keyval)?;
    Some(SuperKey {
        key,
        code,
        ctrl: state.contains(ModifierType::CONTROL_MASK),
        shift: state.contains(ModifierType::SHIFT_MASK),
        alt: state.contains(ModifierType::MOD1_MASK),
    })
}

/// Takes the window's keys with Super from WebKit and presses them in the page with `metaKey` (see the note at the
/// top). A window whose webview cannot be reached says so in the log, and its keys stay as they were.
pub fn forward_super_keys(window: &WebviewWindow) {
    let page = window.clone();
    let installed = window.with_webview(move |webview| {
        webview.inner().connect_key_press_event(move |_, event| {
            let Some(pressed) = super_key(event.keyval(), event.state()) else {
                return Propagation::Proceed;
            };
            if let Err(error) = page.eval(press_script(&pressed)) {
                eprintln!("omp app: a key with Super did not reach the page: {error}");
            }
            Propagation::Stop
        });
    });
    if let Err(error) = installed {
        eprintln!("omp app: keys with Super do not reach the page: {error}");
    }
}

/// The page's keydown and keyup for `pressed`, on the focused element, as the app's key handlers listen for them.
fn press_script(pressed: &SuperKey) -> String {
    format!(
        "(() => {{ const init = {{ key: {key:?}, code: {code:?}, metaKey: true, ctrlKey: {ctrl}, \
         shiftKey: {shift}, altKey: {alt}, bubbles: true, cancelable: true, composed: true }}; \
         const target = document.activeElement ?? document.body; \
         target.dispatchEvent(new KeyboardEvent(\"keydown\", init)); \
         target.dispatchEvent(new KeyboardEvent(\"keyup\", init)); }})()",
        key = pressed.key,
        code = pressed.code,
        ctrl = pressed.ctrl,
        shift = pressed.shift,
        alt = pressed.alt,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn with_super(more: ModifierType) -> ModifierType {
        ModifierType::SUPER_MASK | more
    }

    #[test]
    fn the_resize_key_reaches_the_page_as_an_arrow_with_super_ctrl_and_shift() {
        let state = with_super(ModifierType::CONTROL_MASK | ModifierType::SHIFT_MASK);
        assert_eq!(
            super_key(keysyms::Right, state),
            Some(SuperKey {
                key: "ArrowRight",
                code: "ArrowRight",
                ctrl: true,
                shift: true,
                alt: false,
            })
        );
    }

    #[test]
    fn super_that_gtk_reports_as_mod4_counts_too() {
        let state = ModifierType::MOD4_MASK | ModifierType::CONTROL_MASK;
        let pressed = super_key(keysyms::Left, state).map(|key| (key.code, key.ctrl, key.shift));
        assert_eq!(pressed, Some(("ArrowLeft", true, false)));
    }

    #[test]
    fn a_bracket_named_with_shift_held_is_the_bracket_key() {
        let state = with_super(ModifierType::CONTROL_MASK | ModifierType::SHIFT_MASK);
        let pressed = super_key(keysyms::braceright, state).map(|key| key.code);
        assert_eq!(pressed, Some("BracketRight"));
    }

    #[test]
    fn keys_without_super_stay_with_webkit() {
        let state = ModifierType::CONTROL_MASK | ModifierType::SHIFT_MASK;
        assert_eq!(super_key(keysyms::Right, state), None);
    }

    #[test]
    fn super_that_webkit_reports_as_meta_itself_stays_with_webkit() {
        // Where a keymap makes Super Meta too, WebKit sets `metaKey` itself; pressing it again would act twice.
        let state = with_super(ModifierType::META_MASK | ModifierType::CONTROL_MASK);
        assert_eq!(super_key(keysyms::Right, state), None);
    }

    #[test]
    fn a_key_the_app_does_not_bind_with_super_stays_with_webkit() {
        let state = with_super(ModifierType::CONTROL_MASK);
        assert_eq!(super_key(keysyms::a, state), None);
    }
}
