# omp app documentation

omp app is a chat app for omp, the coding agent: a desktop window for Linux and a web app for your other devices. The [front page](../README.md) says what it does. These pages say how to use it and how it is built.

## Use the app

| Page | What it answers |
|---|---|
| [Install](install.md) | What you need, how to download and check the two packages, how to install, start, update and remove them, how the user service works, and where the app keeps its files. |
| [Other devices](devices.md) | How to open the app from a phone, tablet or another computer over your tailnet, pair and remove devices, add it to an iPhone or iPad Home Screen, open another computer's server in the desktop window, and share a port. |
| [Using the app](using.md) | Every part of the app, one section each: the chat list and workspaces, a chat, the message box, models and plan mode, the side panel, the dashboard, Settings, the palette and its table of keys, tours, the phone layout, and omp in the terminal. |
| [Configuration](configuration.md) | The options of the `omp-app` and `omp-app-desktop` commands, the environment variables, the folders and files the app keeps, and the omp settings it reads or changes. |
| [Troubleshooting](troubleshooting.md) | What each message the app shows or prints means and what to do about it, and how to save the debug log. |

## Work on the code

| Page | What it answers |
|---|---|
| [Architecture](architecture.md) | How the app is put together: the processes, the wire between the page and the server, the chat host, storage, and the checks that keep the server private. |
| [Development](development.md) | What you need to work on the code, how to run it from a checkout, and the conventions the code follows. |
| [Testing](testing.md) | The test suites, how to run each, and what CI runs. |
| [Releasing](releasing.md) | How releases and packages are built and published, and how an installed app gets an update. |
| [Contributing](../CONTRIBUTING.md) | Who can contribute, the checks a change must pass, and the design rules. |

Each workspace has a short page of its own:

| Page | What it covers |
|---|---|
| [packages/server](../packages/server/README.md) | The server, the chat host on omp's SDK, and the stores. |
| [packages/client](../packages/client/README.md) | The browser's WebSocket client. |
| [packages/contracts](../packages/contracts/README.md) | The shared types and schemas. |
| [apps/ui](../apps/ui/README.md) | The web app. |
| [apps/desktop](../apps/desktop/README.md) | The desktop window. |
| [apps/web](../apps/web/README.md) | The end-to-end tests. |

## Also in the repository

- [SECURITY.md](../SECURITY.md) says how to report a vulnerability, what the app guards, and what it assumes.
- [LICENSE](../LICENSE) is the MIT license. [NOTICE](../NOTICE) covers the logo, which is omp's.
