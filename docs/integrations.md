# Integrations

omp app's chat can sit in another app's panel: a browser extension's side panel, an editor's webview, a notes app's side panel, a web page of your own. The panel shows the app's lite view (`/lite`) in a frame. The page that frames it is the **host**: it can tell the panel what the person is looking at, give the chat tools of its own, and set the panel's look.

The lite view is one chat and its message box. Its header names the chat; a click on the name lists the folder's recent chats, and **Find a chat** there finds any of the folder's chats by its title. Beside it, a pencil starts a new chat, and the arrow opens the chat in the full app: in a browser tab, or, once **Open in the desktop app** was chosen in the menu beside it (⌄), in the desktop app's window, through an `omp-app:` link that the desktop app's package registers ([Configuration](configuration.md#what-does-the-omp-app-desktop-command-take)). The panel keeps that choice. The first time, the browser asks whether to open the omp app.

## Which pages may show the app in a panel?

None, until you name them. The app runs commands on its computer, so it lets only the pages you name frame it, and never a page of the internet.

Name them in **Settings → App → Integrations**:

- **Kinds of panel.** One switch each for every Firefox and Zen extension (`moz-extension:`), every Chrome and Edge extension (`chrome-extension:`), and VS Code's panels (`vscode-webview:` with `vscode-file:`).
- **Another page's address.** An HTTPS address (`https://notes.example.com`, a port allowed), a loopback address with its port (`http://127.0.0.1:<port>`, `http://localhost:<port>`), or one extension's own address (`moz-extension://<uuid>`, `chrome-extension://<id>`). Anything else is refused, and the message says what the app takes.

A change counts from the panel's next load: no restart. The list is kept in `embedders.json` in the app's data folder ([Configuration](configuration.md#the-app-data-folder)). `OMP_APP_FRAME_ANCESTORS` names more pages when the app starts; Settings lists them as set when the app started, and does not change them.

No other page of the app can be framed, whatever the list says.

## How does a panel sign in?

A panel is a device, and pairs once, as any device does ([Other devices](devices.md#how-do-i-pair-a-device)): it asks and you allow it, or you type a one-time code into it.

After that, a panel on a page of the app's own site (the same host name, on another port) keeps its key in the app's cookie, as a browser tab does. A panel inside another app (an extension's, an editor's) cannot: a browser keeps no cookie of the app in another site's frame, so the panel would pair at every start. For these, the host keeps the key:

1. The host frames `/lite?embed=1`. The library does this when you give it a place for the key (`keys`, below).
2. When the panel pairs, the app hands the key to the panel's page, which passes it to the host (`credential`).
3. The host keeps it in its own storage (an extension's `storage.local`, an editor's secret storage), out of any web page's reach, and gives it back in its `hello` each time the panel loads. The panel signs in with it.

The key is the device: whoever holds it is signed in as that panel. Removing the panel in **Settings → App → Devices** ends it at once.

## What can a host do?

| The host can | The host cannot |
|---|---|
| Set the panel's look and the empty chat's words (theme, colours, font, greeting, suggestions, placeholder). | Read the chat, the transcript or anything else in the panel: the frame is another site's. |
| Say what the person is looking at (a title, an address, a selection, some text). It goes with each message sent from the panel, which shows it as a chip the person can remove. | Send a message, answer a question or approve anything: only the person, in the panel, does that. |
| Give the chat tools: omp offers them by name, with its own, and the host's answer goes back to omp. Only the chat in that panel gets them, and only that panel answers their calls; when the panel closes, a call that waits fails. | Reach other chats, other devices' pages or the app's server: it talks to its own panel only. |
| Say which project is open on its own computer (`files`), the one its tools reach. The panel's chats stay ordinary chats in the app's folder on the server, with omp's own tools for the server's files and shell beside the host's. | Choose the panel's folder on the server: its chats run where the app's other chats run. |

## The embed protocol

The host and the panel talk with `postMessage`. Every message is an object with `omp: "embed"`, the version `v: 1` and a `type`. The panel takes messages only from the window that frames it, and only from the origin of its first `hello`; it sends only to that origin, except `listening`, which carries nothing. The schemas are in `packages/contracts/src/core/embed.ts`.

| From | `type` | What it carries |
|---|---|---|
| panel | `listening` | Nothing: the panel's page loaded and listens. Sent at every load, so the host says `hello` again after each. |
| host | `hello` | `host` (its name: lowercase letters, digits and dashes), and optionally `settings`, `context`, `tools`, `credential` (the key it keeps) and `files` (below). |
| panel | `ready` | `chat` (the chat shown) and `tools` (the host's tools the chat took); again whenever the panel shows another chat. |
| host | `settings` | `theme`, `look`, `greeting`, `suggestions`, `placeholder`; each one left out stays as it was. |
| host | `context` | What is open now: `{ kind, title, uri, text?, selection? }`, or `null`. |
| host | `tools` | The host's tools from now on: `{ name, description, parameters }`, `parameters` a JSON Schema object; 64 at most. |
| panel | `tool_call` | `callId`, `name` and `arguments` of a call omp made. |
| host | `tool_result` | `callId` and `result`: `{ content: [{ type: "text", text } or { type: "image", data, mimeType }], isError? }`. |
| panel | `tool_cancel` | `callId` of a call omp gave up: no answer is needed. |
| panel | `credential` | `key`: the panel paired, and the host keeps this key. Only for `/lite?embed=1`. |

**`files`: the project open on the host's computer.** An editor on another computer than the app's server says which project is open: `files: { project, id }`, the project's name (64 characters at most) and an id the host derives from its folder (8 to 64 lowercase hex digits; the VS Code extension takes 16 of the SHA-256 of the folder's path). Only the first `hello` of a load counts. It names the project the host's tools reach; the panel's chats still run where the app's other chats run, in the app's folder on the server, with omp's own tools for the server's files and shell, so a chat in the panel works on both: the server's files with omp's tools, the project on the host's computer with the host's.

## The `@omp-app/embed` library

`packages/embed` does all of the above for a host: it makes the frame, says `hello` at each load of the panel, sends what changes, answers each call of a tool with its handler, and keeps the key where you say. `bun run --cwd packages/embed build` writes it as one module, `packages/embed/dist/omp-embed.js`, with no other code in it.

```ts
openPanel(options: PanelOptions): Panel
```

| Option | What it is |
|---|---|
| `app` | The app's address: an HTTPS one, or a loopback one on the host's computer. |
| `into` | The element the frame goes into; the frame fills it. |
| `host` | The host's name, shown beside what goes with each message. |
| `settings`, `context` | As in the protocol. |
| `tools` | The host's tools, each with `run(args, signal)`: it returns the answer's text or a `result`; an error thrown goes back as the call's error; `signal` aborts when omp gives the call up, or when the panel loads again or closes. |
| `files` | `{ project, id }`: the project's files are on the host's computer (see `files` above). |
| `keys` | `{ get(), set(key) }`: where the host keeps the panel's key. Give it for a panel inside another app; leave it out for a page on the app's own site, which keeps the app's cookie. |
| `params` | The address's parameters for the first paint (`theme`, `greeting`, `placeholder`, the look's colours). |
| `chat` | The chat to open, as `onReady` named it before: a host that keeps one chat per tab or document gives it back, and the panel opens it again (the lite view's `?chat=<id>`). Left out, the panel starts a new chat. |
| `onReady` | Called with `{ chat, tools }` when the panel shows a chat. |
| `title` | The frame's name for screen readers. |

The `Panel` it returns has `setSettings`, `setContext`, `setTools` and `close`, and the `frame` itself. `appAddressOf(typed)` checks an address a person typed: it gives `{ address }`, the origin, for an `https` address or a loopback `http` one with its port, and `{ problem }`, a sentence to show, for anything else.

## A minimal host

A page of plain HTML that shows the panel, keeps its key in the page's own storage and gives the chat one tool. Serve it from an address the app lets frame it (here `http://localhost:8080`, named in **Settings → App → Integrations**), with `omp-embed.js` beside it:

```html
<!doctype html>
<title>My host</title>
<div id="panel" style="width: 420px; height: 760px"></div>
<script type="module">
  import { openPanel } from "./omp-embed.js";

  const panel = openPanel({
    app: "http://127.0.0.1:4317",
    into: document.getElementById("panel"),
    host: "my-host",
    // A real extension or editor keeps the key in its own storage, not a web page's.
    keys: {
      get: () => localStorage.getItem("omp-key"),
      set: (key) => localStorage.setItem("omp-key", key),
    },
    tools: [
      {
        name: "page_title",
        description: "Says the title of the page the host shows",
        parameters: { type: "object", properties: {} },
        run: () => `The page is called ${document.title}.`,
      },
    ],
  });

  panel.setContext({ kind: "page", title: document.title, uri: location.href });
</script>
```

The first time, the panel asks to pair; allow it, or make a one-time code in **Settings → App → Devices** and type it in the panel. Each load after that, the panel opens signed in. The end-to-end test `apps/web/e2e/v2-embed-hosts.spec.ts` runs this page against the real app.

## Hosts in this repository

- **Firefox and Zen** ([apps/zen](../apps/zen/README.md)): the chat in the sidebar, for the tab it was opened on. Its tools read the page, take a picture of it, click, type, scroll, go to an address, open tabs of its own and wait for text, on that tab and the tabs it opened only. Turn on **Firefox and Zen extensions** in Settings → App → Integrations.
- **VS Code** ([apps/vscode](../apps/vscode/README.md)): the chat in VS Code's secondary side bar, on the right beside its other chat panels, for the folder open there, on the computer VS Code runs on (VS Code 1.106 or newer). Its tools read, list, search and change the folder's files, run commands in it, and show VS Code's errors; each change shows as a diff to accept or reject, and each command asks first. Turn on **VS Code** in Settings → App → Integrations.
