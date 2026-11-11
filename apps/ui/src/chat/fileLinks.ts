import { WorkspaceRelativePath } from "@omp-app/contracts";

/** What a reply's link to a file names (#17): a file of the chat's folder, or a place outside it. */
export type FileLink =
  | { readonly kind: "file"; readonly path: WorkspaceRelativePath }
  | { readonly kind: "outside"; readonly path: string };

/**
 * The file a link names, in the chat's folder (#17): `file://` and percent escapes decoded; a `?query`, a `#fragment`
 * and a trailing `:line` or `:line:column` dropped; `.` and `..` resolved. A path that leaves the folder, an absolute one
 * elsewhere, or one from a home folder (`~`) is outside: a reply's links open only its chat's own files, as the Files
 * panel does, so no reply can lead a click anywhere else on the computer. Which links name files: `isFileHref`.
 */
export function resolveFileLink(href: string, folder: string): FileLink {
  let raw = href.trim();
  if (/^file:/i.test(raw)) {
    try {
      raw = new URL(raw).pathname;
    } catch {
      return { kind: "outside", path: raw };
    }
  }
  raw = raw.replace(/[?#].*$/, "");
  try {
    raw = decodeURIComponent(raw);
  } catch {}
  raw = raw.replace(/:\d+(?::\d+)?$/, "");
  if (raw.startsWith("~")) return { kind: "outside", path: raw };
  const root = folder.replace(/\/+$/, "");
  const parts: string[] = [];
  for (const part of (raw.startsWith("/") ? raw : `${root}/${raw}`).split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  const full = `/${parts.join("/")}`;
  const path = WorkspaceRelativePath.safeParse(full.slice(root.length + 1));
  if (!full.startsWith(`${root}/`) || !path.success) return { kind: "outside", path: full };
  return { kind: "file", path: path.data };
}
