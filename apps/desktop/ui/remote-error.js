// Names the other computer on remote-error.html. The window passes it as `?host=` (see `show_remote_error` in
// src-tauri/src/server.rs); the token is never part of it. A separate file, since the window's pages run no inline script.
const host = new URLSearchParams(location.search).get("host");
if (host) document.getElementById("host").textContent = host;
