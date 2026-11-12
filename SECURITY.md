# Security

## Reporting a problem

Report a vulnerability privately through GitHub: the repository's **Security** tab, then **Report a vulnerability**.
Please do not open a public issue for it. Only the latest release gets fixes.

## What the app guards

omp app runs omp, a coding agent that reads and changes files and runs commands as your account. Whoever can use the
app can do what your account can do on the computer it runs on, so the app is built to be reachable by you alone:

- **The server listens on this computer only** (127.0.0.1, port 4317 by default).
- **On this computer,** a browser signs in with the link `omp-app` prints (its secret follows `#token=`). The token is
  kept in a file only your account can read, and it counts only for a page of this computer: a request that came
  through a proxy, or that asks for the address other devices open, cannot use it.
- **From another device,** the app is reached only at the HTTPS address set in `OMP_APP_REMOTE_ORIGIN`, through
  what serves it on this computer (Tailscale Serve, a reverse proxy, a tunnel); the app takes no plain `http://`
  address for another computer. Each device pairs once: by matching the six digits the new device shows
  with those on a paired device, or with a one-time code that works once, for 10 minutes. A paired device's key is a
  cookie that only the app's own pages send; the app keeps only a hash of each key, and removing a device ends its
  sessions. A panel inside another app (a browser extension's sidebar, an editor's panel) gets no cookie of the app:
  its host keeps the key, out of any web page's reach, and the panel sends it in its connection's WebSocket protocols,
  never in an address.
- **Shared ports and pages** (the Ports panel) open only at this computer's address for shares (its Tailscale address,
  or `OMP_APP_SHARE_ADDRESS`), over plain HTTP, for paired devices, through a link the app hands out. A request that
  another page makes (another share, or another site) is refused, and a shared page serves no hidden files.
- **The desktop window** gives its commands (clipboard, servers, windows, notifications) only to the pages of the
  server it opened, by exact address, and the four that choose its server (the servers it opened, another address,
  this computer's server) to its own page for a server that did not open; any other page opens in your browser.

## What it assumes

- **One person per computer.** Another account on the same computer can reach the server's port: the token and
  pairing keep it out of the app, and the app refuses a chat-host folder that is not yours alone, but a service you
  share is only as private as the service itself. The same goes for the app's browser features while they run: the
  server's own browser takes DevTools connections, and the relay to your own browser takes its extension's, both on
  this computer's loopback address only (ports 9333 and 9224) and without a password.
- **omp's own rules apply in chats.** What a chat may do (its tools, approvals and modes) is omp's, with your
  account's permissions.
