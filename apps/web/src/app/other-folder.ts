import { FolderPath } from "@omp-app/contracts";

/**
 * What the "Other folder…" field does with a typed path: the folder to open, or the one sentence that says what to type
 * instead. Each refusal has its own sentence. A trailing separator is not a refusal: FolderPath drops it, so `/live/x/`
 * opens `/live/x`.
 */
type OtherFolder =
  | { readonly ok: true; readonly folder: FolderPath }
  | { readonly ok: false; readonly message: string };

export function otherFolderOf(typed: string): OtherFolder {
  const path = typed.trim();
  if (path.length === 0) return { ok: false, message: "Type a folder path." };
  if (path.startsWith("~")) {
    return {
      ok: false,
      message: "~ is not expanded here. Type the full path, for example /home/you/project.",
    };
  }
  const parsed = FolderPath.safeParse(path);
  if (!parsed.success) {
    return {
      ok: false,
      message: "Type the full path to the folder, for example /home/you/project.",
    };
  }
  return { ok: true, folder: parsed.data };
}
