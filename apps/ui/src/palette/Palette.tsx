import type { AppClient } from "@omp-app/client";
import type { FileSearchCandidate } from "@omp-app/contracts";
import type { ChatHostCommand } from "@omp-app/contracts/chat-host";
import { CornerDownLeft } from "lucide-react";
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
import { pauseAllChats } from "../chat/pauseAll";
import type { ChatModel } from "../chat/store";
import { mentionText } from "../chat/triggers";
import { focusNewTodo, showTodoList } from "../dashboard/waiting";
import { debugLogFailureText, saveDebugLog, savedDebugLogText } from "../debugLog";
import {
  type Bridge,
  type DesktopServers,
  desktopBridge,
  desktopServers,
  openDesktopServer,
  refusalText,
  type ServerChoice,
} from "../desktop/bridge";
import { LOCAL_SERVER_LABEL, remoteServerLabel } from "../desktop/ServerSection";
import { KEYS, keycap } from "../keys/table";
import { showPanel, togglePanel, usePanelState } from "../panels/panel-state";
import { PANELS } from "../panels/registry";
import type { ChatList } from "../sidebar/useChatList";
import { setSystemTheme, setThemeChoice, setThemeMode, THEMES } from "../theme/theme";
import { startTour } from "../tour/runner";
import { TOURS } from "../tour/tours";
import type { OpenHow, WorkspaceCommand, WorkspaceHandle } from "../workspace/Workspace";

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

/** The workspace's commands in the palette, with their keys (New chat is a row of its own, with a shorter name). */
const WORKSPACE_COMMANDS: readonly Exclude<WorkspaceCommand, "newChat">[] = [
  "splitRight",
  "splitDown",
  "zoom",
  "closePane",
  "swapPane",
  "equalize",
  "paneMode",
  "newTab",
  "nextTab",
  "previousTab",
  "renameTab",
  "closeTab",
  "reopenTab",
];

const FILE_PAUSE_MS = 120;

/**
 * The focused chat's modes: plan mode on or off (where omp offers it), a goal when the chat has none going, the
 * chat's side questions (omp's `/btw`), and its pause (omp's `/pause`).
 */
function chatModes(
  controller: ChatController | null,
  close: (then: () => void) => void,
  onSetGoal: (controller: ChatController) => void,
): readonly Item[] {
  if (controller === null) return [];
  const { planMode, goal, pausedAt } = controller.store.getSnapshot();
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
              controller.store.toast(
                `Plan mode: ${failure instanceof Error ? failure.message : String(failure)}`,
                "error",
              ),
            );
        }),
    });
  }
  const paused = pausedAt !== null;
  items.push({
    key: "chat:pause",
    group: "Commands",
    label: paused ? "Resume this chat" : "Pause this chat",
    detail: paused ? undefined : "Every agent holds at its next step",
    run: () =>
      close(() => {
        (paused ? controller.resume() : controller.pause()).catch((failure: unknown) =>
          controller.store.toast(
            `${paused ? "Resume" : "Pause"}: ${failure instanceof Error ? failure.message : String(failure)}`,
            "error",
          ),
        );
      }),
  });
  if (goal === null || goal.status === "dropped" || goal.status === "complete") {
    items.push({
      key: "chat:goal",
      group: "Commands",
      label: "Set a goal for this chat…",
      run: () => close(() => onSetGoal(controller)),
    });
  }
  items.push({
    key: "chat:models",
    group: "Commands",
    label: KEYS.modelHub.label,
    keys: keycap(KEYS.modelHub),
    run: () => close(() => controller.modelHubToggle.show()),
  });
  items.push({
    key: "chat:secret",
    group: "Commands",
    label: "Add a secret…",
    detail: "The AI sees only its placeholder",
    run: () => close(() => controller.addSecretToggle.show()),
  });
  return items;
}

/**
 * The desktop window's servers, in the window only: connect to another by its link (in the settings' Server section),
 * this computer's server, and the servers on other computers the window opened, but the one it shows.
 */
function windowServers(
  bridge: Bridge | null,
  servers: DesktopServers | null,
  close: (then: () => void) => void,
  onServers: () => void,
  controller: ChatController | null,
): readonly Item[] {
  if (bridge === null) return [];
  const move = (choice: ServerChoice) => () =>
    close(() => {
      openDesktopServer(bridge, choice).catch((failure: unknown) =>
        controller?.store.toast(`Server: ${refusalText(failure)}`, "error"),
      );
    });
  const items: Item[] = [
    {
      key: "server:connect",
      group: "Commands",
      label: "Connect to another server…",
      run: () => close(onServers),
    },
  ];
  if (servers === null) return items;
  if (servers.current !== null) {
    items.push({
      key: "server:local",
      group: "Commands",
      label: LOCAL_SERVER_LABEL,
      run: move({ kind: "local" }),
    });
  }
  for (const host of servers.remote) {
    if (host === servers.current) continue;
    items.push({
      key: `server:${host}`,
      group: "Commands",
      label: remoteServerLabel(host),
      run: move({ kind: "host", host }),
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
  client,
  list,
  workspace,
  folder,
  onOpenChat,
  onShortcuts,
  onSetGoal,
  onSettings,
  onDashboard,
  onServers,
  onNewWindow,
  onInbox,
  onWhatsNew,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly client: AppClient;
  readonly list: ChatList;
  readonly workspace: RefObject<WorkspaceHandle | null>;
  readonly folder: string;
  readonly onOpenChat: (target: ChatTarget, how: OpenHow) => void;
  readonly onShortcuts: () => void;
  /** Opens the goal dialog for a chat. */
  readonly onSetGoal: (controller: ChatController) => void;
  readonly onSettings: () => void;
  /** Opens the dashboard: usage windows, pace, rules and the queue (#2836). */
  readonly onDashboard: () => void;
  /** Opens the settings at the desktop window's servers, the cursor in the link field. */
  readonly onServers: () => void;
  /** Opens another desktop window, in the desktop window only. */
  readonly onNewWindow: () => void;
  /** Opens the inbox: the chats waiting for you, and what runs settled with while you were elsewhere. */
  readonly onInbox: () => void;
  /** Opens the What's new list: every update and its tours. */
  readonly onWhatsNew: () => void;
}): ReactNode {
  const [scope, setScope] = useState<Scope>("All");
  const [query, setQuery] = useState("");
  /** The highlighted row's key: cmdk reports a highlight (also its own, as a search narrows the rows) only when told it. */
  const [highlighted, setHighlighted] = useState("");
  const sidePanel = usePanelState();
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
    setHighlighted("");
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

  // The desktop window's servers, read as the palette opens there.
  const bridge = desktopBridge();
  const [servers, setServers] = useState<DesktopServers | null>(null);
  useEffect(() => {
    if (!open || bridge === null) return;
    let alive = true;
    desktopServers(bridge)
      .then((found) => alive && setServers(found))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [open, bridge]);

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
      {
        // A blank focused window takes it; else it opens in a workspace of its own (#2831).
        key: "app:newChat",
        group: "Commands",
        label: "New chat",
        keys: keycap(KEYS.newChat),
        run: () => close(() => workspace.current?.command("newChat")),
      },
      ...WORKSPACE_COMMANDS.map((id) => ({
        key: `app:${id}`,
        group: "Commands" as const,
        label: KEYS[id].label,
        keys: keycap(KEYS[id]),
        run: () => close(() => workspace.current?.command(id)),
      })),
      {
        key: "theme:system",
        group: "Commands",
        label: "Theme: match the system",
        run: () => close(() => setThemeMode("system")),
      },
      ...THEMES.map((theme) => ({
        key: `theme:${theme.id}`,
        group: "Commands" as const,
        label: `Theme: ${theme.name}`,
        detail: theme.mode === "dark" ? "Dark" : "Light",
        // Chosen before the palette closes, so the preview never flicks back to the old theme.
        run: () => {
          setSystemTheme(theme.id);
          setThemeChoice(theme.id);
          close(() => undefined);
        },
      })),
      {
        key: "app:shortcuts",
        group: "Commands",
        label: KEYS.shortcuts.label,
        keys: keycap(KEYS.shortcuts),
        run: () => close(onShortcuts),
      },
      {
        key: "app:whatsNew",
        group: "Commands",
        label: "What's new",
        detail: "Every update and its tours",
        run: () => close(onWhatsNew),
      },
      ...chatModes(controller, close, onSetGoal),
      ...([true, false] as const).map((paused) => ({
        key: paused ? "chats:pauseAll" : "chats:resumeAll",
        group: "Commands" as const,
        label: paused ? "Pause all chats" : "Resume all chats",
        detail: paused ? "Every running chat holds at its next step" : undefined,
        run: () =>
          close(() => {
            pauseAllChats(client, paused).then(
              (said) => controller?.store.toast(said, "info"),
              (failure: unknown) =>
                controller?.store.toast(
                  failure instanceof Error ? failure.message : String(failure),
                  "error",
                ),
            );
          }),
      })),
      {
        key: "app:settings",
        group: "Commands",
        label: KEYS.settings.label,
        keys: keycap(KEYS.settings),
        run: () => close(onSettings),
      },
      {
        key: "app:dashboard",
        group: "Commands",
        label: KEYS.dashboard.label,
        detail: "Every chat's questions, the to-do list, usage and statistics",
        keys: keycap(KEYS.dashboard),
        run: () => close(onDashboard),
      },
      {
        key: "app:addTodo",
        group: "Commands",
        label: "Add a to-do",
        detail: "The dashboard's to-do list, ready to type",
        run: () =>
          close(() => {
            onDashboard();
            focusNewTodo();
          }),
      },
      {
        key: "app:openTodos",
        group: "Commands",
        label: "Open the to-do list",
        detail: "The list you and your chats' agents keep, on the dashboard",
        run: () =>
          close(() => {
            onDashboard();
            showTodoList();
          }),
      },
      {
        key: "app:sidePanel",
        group: "Commands",
        label: sidePanel.open ? "Hide the side panel" : "Show the side panel",
        keys: keycap(KEYS.sidePanel),
        run: () => close(togglePanel),
      },
      {
        key: "app:inbox",
        group: "Commands",
        label: "Inbox",
        detail: "Chats waiting for you, and turns that ended while you were elsewhere",
        run: () => close(onInbox),
      },
      {
        key: "app:debugLog",
        group: "Commands",
        label: "Save debug log",
        detail: "What the app did, as one file to attach to an issue",
        run: () =>
          close(() => {
            saveDebugLog(client).then(
              (fileName) => controller?.store.toast(savedDebugLogText(fileName), "info"),
              (failure: unknown) => controller?.store.toast(debugLogFailureText(failure), "error"),
            );
          }),
      },
      // Another desktop window; a browser has none to open.
      ...(bridge === null
        ? []
        : [
            {
              key: "app:newWindow",
              group: "Commands" as const,
              label: KEYS.newWindow.label,
              keys: keycap(KEYS.newWindow),
              run: () => close(onNewWindow),
            },
          ]),
      ...PANELS.map((panel) => ({
        key: `panel:${panel.id}`,
        group: "Commands" as const,
        label: `Side panel: ${panel.title}`,
        run: () => close(() => showPanel(panel.id)),
      })),
      ...TOURS.map((tour) => ({
        key: `tour:${tour.id}`,
        group: "Commands" as const,
        label: `Tour: ${tour.title}`,
        detail: `${tour.minutes} min`,
        run: () =>
          close(() => {
            if (workspace.current !== null) startTour(tour, workspace.current);
          }),
      })),
      ...windowServers(bridge, servers, close, onServers, controller),
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
              "front",
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
        data-tour="palette"
        showCloseButton={false}
        className="top-1/4 translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-xl"
      >
        <DialogTitle className="sr-only">Palette</DialogTitle>
        <Command
          shouldFilter={false}
          className="h-auto"
          value={highlighted}
          onValueChange={setHighlighted}
        >
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
            ↑↓ navigate · <CornerDownLeft aria-hidden className="inline size-3 align-[-0.125em]" />
            <span className="sr-only">enter</span> run · esc close
          </p>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
