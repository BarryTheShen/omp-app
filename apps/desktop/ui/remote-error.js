// Names the other computer on remote-error.html, and why the app did not open there, and lets the window go somewhere
// else: the same server again, this computer's server, another address, or a server it opened before. The window passes
// the computer and the reason as `?host=` and `?problem=` (see `show_remote_error` in src-tauri/src/server.rs); the
// token is never part of either. The buttons call the window's server commands (src-tauri/src/commands.rs), which this
// page may call (src-tauri/capabilities/app-pages.json); each moves the window, so the page goes away when one works. A
// separate file, since the window's pages run no inline script. All of it is inside one function: the window has globals
// of its own (the webview's `ipc`), and a script with a top-level name that repeats one of them does not run at all.
(() => {
  const query = new URLSearchParams(location.search);
  const host = query.get("host");
  if (host) document.getElementById("host").textContent = host;
  // The computer answered, but the app did not open there (see `watch_page_loads` in src-tauri/src/server.rs).
  const problem = query.get("problem");
  if (problem) {
    document.getElementById("what").textContent = "omp app did not open on";
    document.getElementById("why").textContent =
      "This window opens the app's server on another computer. That computer answered, but the app " +
      `did not open there (${problem}). The app's server on it may be stopped, or another program answers at that address.`;
  }

  const tauri = window.__TAURI_INTERNALS__;
  const said = document.getElementById("problem");
  const buttons = () => document.querySelectorAll("button");

  /** Moves the window with `command`; while it works the buttons wait, and a refusal is said here. */
  const move = (command, args) => {
    if (!tauri) return;
    said.hidden = true;
    for (const button of buttons()) button.disabled = true;
    tauri.invoke(command, args).catch((failure) => {
      for (const button of buttons()) button.disabled = false;
      said.textContent = `It did not open: ${typeof failure === "string" ? failure : String(failure?.message ?? failure)}`;
      said.hidden = false;
    });
  };

  const again = document.getElementById("again");
  const here = document.getElementById("here");
  if (host) again.addEventListener("click", () => move("open_server", { host }));
  else again.hidden = true;
  here.addEventListener("click", () => move("use_this_computer"));
  // The cursor starts on Try again, so Enter tries again; with no computer named, on Use this computer's server.
  (host ? again : here).focus();
  document.getElementById("other").addEventListener("submit", (event) => {
    event.preventDefault();
    const address = document.getElementById("address").value.trim();
    if (address !== "") move("connect_server", { link: address });
  });

  // The servers this window opened before, other than this one, each a click away.
  tauri
    ?.invoke("servers")
    .then((servers) => {
      const others = (servers?.remote ?? []).filter((other) => other !== host);
      if (others.length === 0) return;
      const list = document.getElementById("servers");
      for (const other of others) {
        const item = document.createElement("li");
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = `Open the server on ${other}`;
        button.addEventListener("click", () => move("open_server", { host: other }));
        item.append(button);
        list.append(item);
      }
      document.getElementById("saved").hidden = false;
    })
    .catch(() => undefined);
})();
