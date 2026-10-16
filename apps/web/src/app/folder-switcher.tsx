import { FolderPath } from "@omp-app/contracts";
import { useRef, useState } from "react";
import { InlineError } from "@/components/blocks";

function folderLabel(folder: FolderPath | undefined): string {
  if (!folder) return "Choose folder…";
  const normalized = folder.replace(/\/+$/, "");
  return normalized.slice(normalized.lastIndexOf("/") + 1) || folder;
}

/**
 * The workspace folder picker in the sessions sidebar. "Other folder…" opens a field for a typed
 * path. A path that cannot be opened closes the field again, so the picker shows the folder that is
 * still open; the reason shows below the picker, and the typed path stays so it can be corrected.
 */
export function FolderSwitcher({
  folder,
  recentFolders,
  error,
  onFolderChange,
  onOtherFolder,
}: {
  readonly folder: FolderPath | null;
  readonly recentFolders: readonly FolderPath[];
  readonly error: string | null;
  readonly onFolderChange: (folder: FolderPath) => void;
  readonly onOtherFolder: (folder: string) => Promise<boolean>;
}) {
  const [otherPath, setOtherPath] = useState("");
  const [otherOpen, setOtherOpen] = useState(false);
  const picker = useRef<HTMLSelectElement>(null);
  const currentValue = folder ?? "";
  const options = [...new Set([...(folder ? [folder] : []), ...recentFolders])];
  return (
    <div
      className="border-sidebar-border bg-sidebar relative z-10 flex shrink-0 flex-col gap-2 border-b p-3"
      data-app-folder-switcher="true"
    >
      <label className="text-muted-foreground text-xs font-medium" htmlFor="workspace-folder">
        Workspace folder
      </label>
      <select
        aria-label="Workspace folder"
        ref={picker}
        className="border-border bg-background text-foreground rounded-(--radius) border px-2 py-1.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
        id="workspace-folder"
        title={folder ?? "Choose a workspace folder"}
        value={otherOpen ? "__other__" : currentValue}
        onChange={(event) => {
          if (event.target.value === "__other__") {
            setOtherOpen(true);
            return;
          }
          const parsed = FolderPath.safeParse(event.target.value);
          if (parsed.success) {
            setOtherOpen(false);
            onFolderChange(parsed.data);
          }
        }}
      >
        {!folder && <option value="">Choose folder…</option>}
        {options.map((option) => (
          <option key={option} value={option}>
            {folderLabel(option)}
          </option>
        ))}
        <option value="__other__">Other folder…</option>
      </select>
      {otherOpen && (
        <div className="flex min-w-0 gap-2">
          <input
            aria-label="Other folder path"
            className="border-border bg-background text-foreground min-w-0 flex-1 rounded-(--radius) border px-2 py-1.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
            placeholder="/path/to/project"
            value={otherPath}
            onChange={(event) => setOtherPath(event.target.value)}
          />
          <button
            className="bg-primary text-primary-foreground rounded-(--radius) px-2 py-1 text-xs font-medium disabled:opacity-50"
            disabled={otherPath.trim().length === 0}
            type="button"
            onClick={async () => {
              // The field closes either way; focus goes back to the picker so keyboard users continue from it.
              const opened = await onOtherFolder(otherPath);
              setOtherOpen(false);
              if (opened) setOtherPath("");
              picker.current?.focus();
            }}
          >
            Use
          </button>
        </div>
      )}
      {error ? <InlineError message={error} variant="compact" /> : null}
    </div>
  );
}
