// Names the other computer on remote-error.html, and why the app did not open there. The window passes them as `?host=`
// and `?problem=` (see `show_remote_error` in src-tauri/src/server.rs); the token is never part of either. A separate
// file, since the window's pages run no inline script.
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
