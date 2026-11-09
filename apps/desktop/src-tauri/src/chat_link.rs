//! Links another app opens to show a chat in the window: `omp-app://chat/<chat id>?server=<origin>`, or
//! `omp-app://open?server=<origin>` for the server alone (the lite view's "Open in the full app" in another app's
//! panel). The package's desktop entry registers the scheme (`linux/omp-app-desktop.desktop.hbs`), so the system starts
//! `omp-app-desktop <link>`; a window already open gets it as a second launch.
//!
//! A link only picks among the servers the app already opens (this computer's, or one on another computer it opened
//! before): a page of a server the window shows may call the window's commands, so a link never brings a new server.
//! The chat id must be a chat's (a UUID): it goes into the page's script as it is.

use tauri::Url;

/// The links' scheme.
pub const SCHEME: &str = "omp-app";

/// The name of the event the page listens for (`apps/ui/src/desktop/openChat.ts`).
const OPEN_CHAT_EVENT: &str = "omp-app:open-chat";

/// What a link asks: the server's origin, and the chat to show there, if it names one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChatLink {
    pub server: String,
    pub chat: Option<String>,
}

/// The first link among a launch's arguments; a link of another shape is not one.
pub fn find(args: &[String]) -> Option<ChatLink> {
    args.iter().find_map(|arg| parse(arg))
}

/// A link of either shape, its server an http or https origin and its chat a chat's id; None for anything else.
pub fn parse(text: &str) -> Option<ChatLink> {
    let url = Url::parse(text.trim()).ok()?;
    if url.scheme() != SCHEME {
        return None;
    }
    let chat = match url.host_str()? {
        "chat" => {
            let id = url.path().trim_start_matches('/');
            is_chat_id(id).then(|| id.to_owned())?
        }
        "open" if url.path().is_empty() || url.path() == "/" => {
            return server_of(&url).map(|server| ChatLink { server, chat: None });
        }
        _ => return None,
    };
    let server = server_of(&url)?;
    Some(ChatLink {
        server,
        chat: Some(chat),
    })
}

/// The `server` parameter's origin: http or https, with a host.
fn server_of(url: &Url) -> Option<String> {
    let (_, text) = url.query_pairs().find(|(name, _)| name == "server")?;
    let server = Url::parse(&text).ok()?;
    let has_host = server.host_str().is_some_and(|host| !host.is_empty());
    (matches!(server.scheme(), "http" | "https") && has_host)
        .then(|| server.origin().ascii_serialization())
}

/// A chat's id: a UUID in lowercase hex, as omp names its sessions.
fn is_chat_id(text: &str) -> bool {
    let groups: Vec<&str> = text.split('-').collect();
    groups.len() == 5
        && groups.iter().zip([8, 4, 4, 4, 12]).all(|(group, length)| {
            group.len() == length
                && group
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        })
}

/// The script that asks a page already open to show the chat. The id is a checked chat id: it needs no escaping.
pub fn open_script(chat: &str) -> String {
    format!("window.dispatchEvent(new CustomEvent({OPEN_CHAT_EVENT:?}, {{ detail: {chat:?} }}));")
}

/// `address` with the chat in its fragment (`#chat=<id>`), beside a token the fragment holds: the page opens it as it
/// loads (`apps/ui/src/workspace/linkChat.ts`).
pub fn address_with_chat(address: &Url, chat: &str) -> Url {
    let mut url = address.clone();
    let fragment = match url.fragment() {
        Some(kept) if !kept.is_empty() => format!("{kept}&chat={chat}"),
        _ => format!("chat={chat}"),
    };
    url.set_fragment(Some(&fragment));
    url
}

#[cfg(test)]
mod tests {
    use super::*;

    const CHAT: &str = "0d2c9a1e-5b7f-4c3a-9e21-7f00aa11bb22";

    #[test]
    fn a_link_names_the_server_and_the_chat() {
        assert_eq!(
            parse(&format!(
                "omp-app://chat/{CHAT}?server=https%3A%2F%2Fdevbox.tail1234.ts.net%2F"
            )),
            Some(ChatLink {
                server: "https://devbox.tail1234.ts.net".to_owned(),
                chat: Some(CHAT.to_owned()),
            })
        );
        assert_eq!(
            parse("omp-app://open?server=http://127.0.0.1:4317"),
            Some(ChatLink {
                server: "http://127.0.0.1:4317".to_owned(),
                chat: None,
            })
        );
    }

    #[test]
    fn anything_else_is_no_link() {
        let server = "server=https://devbox.tail1234.ts.net";
        for text in [
            format!("https://devbox.tail1234.ts.net/?{server}"),
            format!("omp-app://chat/{}?{server}", CHAT.to_uppercase()),
            format!("omp-app://chat/{CHAT}x?{server}"),
            format!("omp-app://chat/not-a-chat?{server}"),
            format!("omp-app://chat/{CHAT}"),
            format!("omp-app://chat/{CHAT}?server=file:///etc/passwd"),
            format!("omp-app://chat/{CHAT}?server=javascript:alert(1)"),
            format!("omp-app://elsewhere/{CHAT}?{server}"),
            format!("omp-app://open/more?{server}"),
            "--new-window".to_owned(),
        ] {
            assert_eq!(parse(&text), None, "{text}");
        }
    }

    #[test]
    fn a_launch_finds_its_link_among_its_arguments() {
        let link = format!("omp-app://chat/{CHAT}?server=http://127.0.0.1:4317");
        let args = vec!["--new-window".to_owned(), link];
        assert_eq!(
            find(&args).and_then(|found| found.chat),
            Some(CHAT.to_owned())
        );
        assert_eq!(find(&["--local".to_owned()]), None);
    }

    #[test]
    fn the_page_gets_the_chat_by_an_event_or_in_its_address() {
        assert_eq!(
            open_script(CHAT),
            format!(
                r#"window.dispatchEvent(new CustomEvent("omp-app:open-chat", {{ detail: "{CHAT}" }}));"#
            )
        );
        let local = Url::parse("http://127.0.0.1:4317/?window=main").unwrap();
        assert_eq!(
            address_with_chat(&local, CHAT).as_str(),
            format!("http://127.0.0.1:4317/?window=main#chat={CHAT}")
        );
        let remote = Url::parse("https://devbox.tail1234.ts.net/#token=abc").unwrap();
        assert_eq!(
            address_with_chat(&remote, CHAT).as_str(),
            format!("https://devbox.tail1234.ts.net/#token=abc&chat={CHAT}")
        );
    }
}
