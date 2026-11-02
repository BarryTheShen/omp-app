/** Names the Files panel gives (#2782): a second copy beside a taken name, and a save that met a conflict. */

/** `name` split before its extension: `notes.md` → `notes` and `.md`; a dotfile or no dot has no extension. */
function split(name: string): readonly [string, string] {
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? [name, ""] : [name.slice(0, dot), name.slice(dot)];
}

/** "Keep both": the first `name (n).ext` not taken. */
export function keepBothName(name: string, taken: ReadonlySet<string>): string {
  const [stem, extension] = split(name);
  for (let n = 1; ; n += 1) {
    const candidate = `${stem} (${n})${extension}`;
    if (!taken.has(candidate)) return candidate;
  }
}

const pad = (value: number) => String(value).padStart(2, "0");

/** "Save as copy" after a conflict: `name (conflict YYYY-MM-DD HHMM).ext`, in the reader's own time. */
export function conflictCopyName(name: string, at: Date): string {
  const [stem, extension] = split(name);
  const day = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
  return `${stem} (conflict ${day} ${pad(at.getHours())}${pad(at.getMinutes())})${extension}`;
}

/** A path's last part. */
export function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** A path's directory, `""` for the folder itself. */
export function parentOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

/** `name` in `directory` (`""` is the folder itself). */
export function childPath(directory: string, name: string): string {
  return directory === "" ? name : `${directory}/${name}`;
}
