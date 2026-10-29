import type { FileSearchCandidate } from "@omp-app/contracts";
import type { ChatHostCommand } from "@omp-app/contracts/chat-host";
import { type ReactNode, type RefObject, useEffect, useState } from "react";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { ChatController, ChatTarget } from "../chat/controller";
import type { ChatModel } from "../chat/store";
import { mentionText } from "../chat/triggers";
import { KEYS, keycap } from "../keys/table";
import type { ChatList } from "../sidebar/useChatList";
import { setThemeChoice, type ThemeChoice } from "../theme/theme";
import type { WorkspaceCommand, WorkspaceHandle } from "../workspace/Workspace";

const SCOPES = ["All", "Commands", "Files", "Chats", "Models"] as const;
type Scope = (typeof SCOPES)[number];

interface Item {
  readonly key: string;
  readonly group: Exclude<Scope, "All">;
  readonly label: string;
  readonly detail?: string | undefined;
  readonly keys?: string | undefined;
  readonly run: () => void;
}

/** The workspace's commands in the palette, with their keys. */
const WORKSPACE_COMMANDS: readonly WorkspaceCommand[] = [
  "splitRight",
  "splitDown",
  "zoom",
  "closePane",
  "swapPane",
  "equalize",
  "newTab",
  "nextTab",
  "previousTab",
  "renameTab",
  "closeTab",
];

const THEMES: readonly (readonly [ThemeChoice, string])[] = [
  ["system", "Theme: match the system"],
  ["tern-light", "Theme: light"],
  ["tern-dark", "Theme: dark"],
];

const FILE_PAUSE_MS = 120;

/** The focused chat's modes: plan mode on or off (where omp offers it), and a goal when the chat has none going. */
function chatModes(
  controller: ChatController | null,
  close: (then: () => void) => void,
  onSetGoal: (controller: ChatController) => void,
): readonly Item[] {
  if (controller === null) return [];
  const { planMode, goal } = controller.store.getSnapshot();
  const items: Item[] = [];
  if (planMode?.available === true) {
    const enabled = planMode.enabled;
    items.push({
      key: "chat:plan",
      group: "Commands",
      label: enabled ? "Turn plan mode off" : "Turn plan mode on",
      keys: keycap(KEYS.planMode),
      run: () =>
        close(() => {
          controller
            .setPlanMode(!enabled)
            .catch((failure: unknown) =>
              controller.store.addNotice(
                `Plan mode: ${failure instanceof Error ? failure.message : String(failure)}`,
                "error",
              ),
            );
        }),
    });
  }
  if (goal === null || goal.status === "dropped" || goal.status === "complete") {
    items.push({
      key: "chat:goal",
      group: "Commands",
      label: "Set a goal for this chat…",
      run: () => close(() => onSetGoal(controller)),
    });
  }
  return items;
}

/**
 * The palette (Ctrl+K), as Tern's: the app's commands and omp's, the folder's files, the chats and the models, each a
 * scope, with "All" by default. A file or one of omp's commands goes into the focused chat's message box.
 */
export function Palette({
  open,
  onOpenChange,
  list,
  workspace,
  folder,
  onOpenChat,
  onShortcuts,
  onSetGoal,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly list: ChatList;
  readonly workspace: RefObject<WorkspaceHandle | null>;
  readonly folder: string;
  readonly onOpenChat: (target: ChatTarget, where: "here" | "split") => void;
  readonly onShortcuts: () => void;
  /** Opens the goal dialog for a chat. */
  readonly onSetGoal: (controller: ChatController) => void;
}): ReactNode {
  const [scope, setScope] = useState<Scope>("All");
  const [query, setQuery] = useState("");
  const [commands, setCommands] = useState<readonly ChatHostCommand[]>([]);
  const [models, setModels] = useState<readonly ChatModel[]>([]);
  const [files, setFiles] = useState<readonly FileSearchCandidate[]>([]);
  const focused = open ? (workspace.current?.focused() ?? null) : null;
  const controller = focused?.controller ?? null;

  // Each opening starts afresh: all scopes, nothing typed (however it was closed: Esc, a click or a run).
  useEffect(() => {
    if (open) return;
    setQuery("");
    setScope("All");
  }, [open]);

  // What the focused chat offers, read as the palette opens.
  useEffect(() => {
    if (controller === null) return;
    let alive = true;
    controller
      .commands()
      .then((found) => alive && setCommands(found))
      .catch(() => undefined);
    controller
      .models()
      .then((found) => alive && setModels(found))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [controller]);

  const wantsFiles = open && (scope === "Files" || scope === "All") && query.trim() !== "";
  useEffect(() => {
    if (!wantsFiles || controller === null) {
      setFiles([]);
      return;
    }
    let alive = true;
    const timer = setTimeout(() => {
      controller
        .searchFiles(query.trim())
        .then((found) => alive && setFiles(found.slice(0, 20)))
        .catch(() => undefined);
    }, FILE_PAUSE_MS);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [wantsFiles, query, controller]);

  const close = (then: () => void): void => {
    onOpenChange(false);
    // After the palette lets go of the focus, so the action can move it.
    requestAnimationFrame(then);
  };

  // Rows for the palette as it is now: cheap, and only while it is open.
  const items: readonly Item[] = (() => {
    const all: Item[] = [
      ...WORKSPACE_COMMANDS.map((id) => ({
        key: `app:${id}`,
        group: "Commands" as const,
        label: KEYS[id].label,
        keys: keycap(KEYS[id]),
        run: () => close(() => workspace.current?.command(id)),
      })),
      ...THEMES.map(([choice, label]) => ({
        key: `theme:${choice}`,
        group: "Commands" as const,
        label,
        run: () => close(() => setThemeChoice(choice)),
      })),
      {
        key: "app:shortcuts",
        group: "Commands",
        label: KEYS.shortcuts.label,
        keys: keycap(KEYS.shortcuts),
        run: () => close(onShortcuts),
      },
      ...chatModes(controller, close, onSetGoal),
      ...commands.map((command) => ({
        key: `omp:${command.name}`,
        group: "Commands" as const,
        label: `/${command.name}`,
        detail: command.description,
        run: () => close(() => focused?.composer?.insert(`/${command.name} `)),
      })),
      ...files.map((file) => ({
        key: `file:${file.path}`,
        group: "Files" as const,
        label: file.path,
        run: () => close(() => focused?.composer?.insert(mentionText(file.path))),
      })),
      ...list.sessions.map((session) => ({
        key: `chat:${session.id}`,
        group: "Chats" as const,
        label: session.displayTitle ?? session.title ?? session.firstPrompt ?? "Untitled chat",
        run: () =>
          close(() =>
            onOpenChat(
              { kind: "existing", threadId: session.id, sessionFile: session.sessionFile },
              "here",
            ),
          ),
      })),
      ...models.map((model) => ({
        key: `model:${model.provider}/${model.id}`,
        group: "Models" as const,
        label: model.name,
        detail: `${model.provider}/${model.id}`,
        run: () => close(() => void controller?.setModel(model).catch(() => undefined)),
      })),
    ];
    const needle = query.trim().toLowerCase();
    return all.filter(
      (item) =>
        (scope === "All" || item.group === scope) &&
        // A file is already what the search found for the query.
        (item.group === "Files" ||
          needle === "" ||
          `${item.label} ${item.detail ?? ""}`.toLowerCase().includes(needle)),
    );
  })();

  const groups = (["Commands", "Files", "Chats", "Models"] as const)
    .map((group) => [group, items.filter((item) => item.group === group)] as const)
    .filter(([, members]) => members.length > 0);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="top-1/4 translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-xl"
      >
        <DialogTitle className="sr-only">Palette</DialogTitle>
        <Command shouldFilter={false} className="h-auto">
          <CommandInput
            placeholder="Search commands, files, chats and models"
            value={query}
            onValueChange={setQuery}
            aria-label="Search the palette"
          />
          <ToggleGroup
            aria-label="Scope"
            className="px-2 pt-2"
            value={[scope]}
            onValueChange={(value: string[]) => {
              const next = value[0] as Scope | undefined;
              if (next !== undefined) setScope(next);
            }}
          >
            {SCOPES.map((each) => (
              <ToggleGroupItem key={each} value={each} size="sm" className="h-6 px-2 text-xs">
                {each}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <CommandList className="max-h-[50vh]" label="Palette">
            <CommandEmpty>
              {scope === "Files" && query.trim() === ""
                ? `Type to search ${folder}.`
                : "Nothing matches."}
            </CommandEmpty>
            {groups.map(([group, members]) => (
              <CommandGroup key={group} heading={group}>
                {members.map((item) => (
                  <CommandItem key={item.key} value={item.key} onSelect={item.run}>
                    <span className="min-w-0 truncate text-t1">{item.label}</span>
                    {item.detail !== undefined && (
                      <span className="min-w-0 truncate text-xs text-t3 group-data-selected/command-item:text-t2">
                        {item.detail}
                      </span>
                    )}
                    {/* A shortcut slot, so the item's own check mark gives up the row's end to it. */}
                    {item.keys !== undefined && (
                      <CommandShortcut className="shrink-0 rounded-sm border border-l2 px-1 font-mono text-[11px] tracking-normal text-t2">
                        {item.keys}
                      </CommandShortcut>
                    )}
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
          <p className="border-t border-l2 px-3 py-1.5 text-xs text-t3">
            ↑↓ navigate · ↵ run · esc close
          </p>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
