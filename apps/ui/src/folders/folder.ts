import { FolderPath } from "@omp-app/contracts";

/** Where this browser keeps the folder chosen last; a launch link's folder counts as a choice. */
const FOLDER_KEY = "omp-app.ui.folder";

/**
 * Keeps the folder the address names (`#folder=<absolute path>`, as a launch link may carry it) as the chosen one, and
 * takes it out of the address, so a reload shows the folder chosen since. A value that is not an absolute path is
 * dropped.
 */
export function keepLinkFolder(): void {
  const params = new URLSearchParams(window.location.hash.slice(1));
  const linked = params.get("folder");
  if (linked === null) return;
  const parsed = FolderPath.safeParse(linked);
  if (parsed.success) storeFolder(parsed.data);
  params.delete("folder");
  const rest = params.toString();
  window.history.replaceState(
    null,
    "",
    `${window.location.pathname}${window.location.search}${rest.length > 0 ? `#${rest}` : ""}`,
  );
}

/** The folder chosen last in this browser; null when none was, or what is kept is not a folder path. */
export function storedFolder(): FolderPath | null {
  try {
    const parsed = FolderPath.safeParse(localStorage.getItem(FOLDER_KEY));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Keeps `folder` as the chosen one; null forgets the choice. */
export function storeFolder(folder: FolderPath | null): void {
  try {
    if (folder === null) localStorage.removeItem(FOLDER_KEY);
    else localStorage.setItem(FOLDER_KEY, folder);
  } catch {
    // Storage that refuses only means the launch folder shows next time.
  }
}

/** What a typed path opens: the folder, or the one sentence that says what to type instead. */
export type TypedFolder =
  | { readonly ok: true; readonly folder: FolderPath }
  | { readonly ok: false; readonly message: string };

/**
 * The folder a typed path names. `~` stands for the home folder when the app knows it (`home`). A trailing separator
 * is no fault: `/live/x/` opens `/live/x`.
 */
export function typedFolder(typed: string, home: FolderPath | null): TypedFolder {
  const text = typed.trim();
  if (text.length === 0) return { ok: false, message: "Type a folder path." };
  let path = text;
  if (text === "~" || text.startsWith("~/")) {
    if (home === null) {
      return {
        ok: false,
        message: "~ is not known here. Type the full path, for example /home/you/project.",
      };
    }
    path = `${home}${text.slice(1)}`;
  }
  const parsed = FolderPath.safeParse(path);
  return parsed.success
    ? { ok: true, folder: parsed.data }
    : { ok: false, message: "Type the full path to the folder, for example /home/you/project." };
}

/** The folder's name in the sidebar: its last part, and `~` for the home folder. */
export function folderName(folder: FolderPath, home: FolderPath | null): string {
  if (folder === home) return "~";
  return folder.slice(folder.lastIndexOf("/") + 1) || folder;
}

/** The folder as the app shows it: from `~` when it is inside the home folder, otherwise in full. */
export function shownFolder(folder: FolderPath, home: FolderPath | null): string {
  if (home === null) return folder;
  if (folder === home) return "~";
  return folder.startsWith(`${home}/`) ? `~${folder.slice(home.length)}` : folder;
}

/**
 * The home folder, from a folder and the way the server shows it (`HostMetadataPort`): `/home/me/code` shown as
 * `~/code` means `/home/me`. Null when the server shows the folder in full, as for one outside the home folder.
 */
export function homeOf(folder: FolderPath, shown: string): FolderPath | null {
  if (shown === "~") return folder;
  if (!shown.startsWith("~/")) return null;
  const tail = shown.slice(1);
  if (!folder.endsWith(tail)) return null;
  const parsed = FolderPath.safeParse(folder.slice(0, folder.length - tail.length));
  return parsed.success ? parsed.data : null;
}
