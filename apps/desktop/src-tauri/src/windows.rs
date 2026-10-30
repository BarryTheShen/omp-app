//! The app's windows: how they are named, which one a launch or a command means, and when a close ends the app. All of
//! it is plain text and numbers, so the rules are tested without a window.
//!
//! The first window is `main`; the others are `window-2`, `window-3`, and so on, each the next free number. Closing a
//! window that is not the last one closes it alone; the last one ends the app.

/// The first window's label. Its layout and its server are the ones the next start restores.
pub const MAIN: &str = "main";
/// What the other windows' labels start with, and the pattern the capabilities grant the page commands to them by.
const PREFIX: &str = "window-";
pub const PATTERN: &str = "window-*";
/// The launch argument that opens another window, in the app that is already open.
pub const NEW_WINDOW_FLAG: &str = "--new-window";

/// The label of the next new window: the lowest `window-N` (N from 2) not among `taken`. A window being closed still
/// counts as taken, because its label is free only once it is gone.
pub fn next_label(taken: &[String]) -> String {
    let mut number = 2_u32;
    loop {
        let label = format!("{PREFIX}{number}");
        if !taken.contains(&label) {
            return label;
        }
        number += 1;
    }
}

/// Whether closing `label` leaves another window open that is not itself being closed. When it does not, this is the
/// last window and its close ends the app.
pub fn closes_alone(open: &[String], closing: &[String], label: &str) -> bool {
    open.iter()
        .any(|other| other != label && !closing.contains(other))
}

/// The window a command that names none means: the one focused last if it is still open, else `main`, else the first
/// open one by label. None when no window is open.
pub fn pick(last_focused: Option<&str>, open: &[String]) -> Option<String> {
    let is_open = |label: &str| open.iter().any(|each| each == label);
    if let Some(label) = last_focused.filter(|label| is_open(label)) {
        return Some(label.to_owned());
    }
    if is_open(MAIN) {
        return Some(MAIN.to_owned());
    }
    open.iter().min().cloned()
}

/// Whether a launch's arguments ask for another window (`--new-window`, which the launcher's "New Window" action runs).
pub fn asks_for_new_window(args: &[String]) -> bool {
    args.iter().any(|arg| arg == NEW_WINDOW_FLAG)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn labels(names: &[&str]) -> Vec<String> {
        names.iter().map(|name| (*name).to_owned()).collect()
    }

    #[test]
    fn a_new_window_takes_the_lowest_free_number() {
        assert_eq!(next_label(&labels(&["main"])), "window-2");
        assert_eq!(next_label(&labels(&["main", "window-2"])), "window-3");
        assert_eq!(
            next_label(&labels(&["main", "window-3"])),
            "window-2",
            "a number a closed window left is free again"
        );
        assert_eq!(next_label(&labels(&[])), "window-2", "main is not a number");
        assert_eq!(
            next_label(&labels(&["window-2", "window-3", "window-4"])),
            "window-5"
        );
    }

    #[test]
    fn a_close_ends_the_app_only_when_no_other_window_stays() {
        let one = labels(&["main"]);
        assert!(
            !closes_alone(&one, &[], "main"),
            "the only window is the last"
        );
        let two = labels(&["main", "window-2"]);
        assert!(closes_alone(&two, &[], "window-2"));
        assert!(closes_alone(&two, &[], "main"), "main may close first");
        assert!(
            !closes_alone(&two, &labels(&["main"]), "window-2"),
            "the other window is already closing, so this one is the last"
        );
        let three = labels(&["main", "window-2", "window-3"]);
        assert!(closes_alone(&three, &labels(&["main"]), "window-2"));
    }

    #[test]
    fn two_windows_closing_at_once_end_the_app_once() {
        // Both ask to close before either is gone: the first is let go, the second finds no one left.
        let open = labels(&["main", "window-2"]);
        let mut closing: Vec<String> = Vec::new();
        let mut decisions = Vec::new();
        for label in ["window-2", "main"] {
            let alone = closes_alone(&open, &closing, label);
            if alone {
                closing.push(label.to_owned());
            }
            decisions.push(alone);
        }
        assert_eq!(decisions, vec![true, false]);
    }

    #[test]
    fn a_command_without_a_window_means_the_one_focused_last_then_main_then_any() {
        let open = labels(&["main", "window-2", "window-3"]);
        assert_eq!(pick(Some("window-3"), &open).as_deref(), Some("window-3"));
        assert_eq!(pick(Some("window-9"), &open).as_deref(), Some("main"));
        assert_eq!(pick(None, &open).as_deref(), Some("main"));
        let without_main = labels(&["window-3", "window-2"]);
        assert_eq!(pick(None, &without_main).as_deref(), Some("window-2"));
        assert_eq!(
            pick(Some("main"), &without_main).as_deref(),
            Some("window-2")
        );
        assert_eq!(pick(Some("main"), &[]), None);
    }

    #[test]
    fn only_the_new_window_flag_asks_for_a_window() {
        assert!(asks_for_new_window(&labels(&["--new-window"])));
        assert!(asks_for_new_window(&labels(&["--local", "--new-window"])));
        assert!(!asks_for_new_window(&labels(&["--local"])));
        assert!(!asks_for_new_window(&labels(&["--new-window=1"])));
        assert!(!asks_for_new_window(&[]));
    }
}
