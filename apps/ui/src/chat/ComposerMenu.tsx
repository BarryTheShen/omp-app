import { File, Folder, SquareSlash } from "lucide-react";
import type { ReactNode } from "react";
import { Command, CommandEmpty, CommandItem, CommandList } from "@/components/ui/command";

/** One row of the `/` or `@` menu. */
export interface MenuItem {
  readonly key: string;
  readonly kind: "command" | "file" | "directory";
  readonly label: string;
  readonly detail?: string | undefined;
}

/**
 * The `/` command and `@` file menu above the message box (cmdk's list). The caret stays in the box: the box moves the
 * highlight with the arrow keys and takes a row with Enter or Tab; a click takes one too.
 */
export function ComposerMenu({
  kind,
  label,
  items,
  active,
  empty,
  onPick,
}: {
  readonly kind: "command" | "file";
  readonly label: string;
  readonly items: readonly MenuItem[];
  readonly active: number;
  readonly empty: string;
  readonly onPick: (index: number) => void;
}): ReactNode {
  return (
    <Command
      data-tour="composer-menu"
      data-kind={kind}
      shouldFilter={false}
      value={items[active]?.key ?? ""}
      className="absolute inset-x-0 bottom-full mb-2 h-auto rounded-xl border border-l2 shadow-lg"
    >
      {/* cmdk names the listbox from the list's own label (its default is "Suggestions"). */}
      <CommandList label={label} className="max-h-72">
        <CommandEmpty>{empty}</CommandEmpty>
        {items.map((item, index) => (
          <CommandItem
            key={item.key}
            value={item.key}
            onSelect={() => onPick(index)}
            // A click must not take the caret out of the message box.
            onMouseDown={(event) => event.preventDefault()}
          >
            {item.kind === "command" ? (
              <SquareSlash className="text-t3" />
            ) : item.kind === "directory" ? (
              <Folder className="text-t3" />
            ) : (
              <File className="text-t3" />
            )}
            <span className="shrink-0 font-mono text-[0.8125rem] text-t1">{item.label}</span>
            {item.detail !== undefined && (
              <span className="min-w-0 truncate text-xs text-t3 group-data-selected/command-item:text-t2">
                {item.detail}
              </span>
            )}
          </CommandItem>
        ))}
      </CommandList>
    </Command>
  );
}
