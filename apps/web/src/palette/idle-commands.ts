import type { DescriptorId } from "@omp-app/contracts";
import type { CommandPaletteHandler } from "./command-palette";

/** What the palette's idle commands do. The app owns each action; the palette only names them. */
export interface IdleCommandActions {
  readonly newChat: () => void | Promise<void>;
  readonly openSettings: () => void;
  readonly setTheme: (preference: "system" | "light" | "dark") => void;
}

/**
 * The palette's commands when no chat is open: New chat, Settings and the three themes. A chat's own commands
 * (fresh, clear, the login that runs in a chat) need an open chat, so they are not offered here. The shortcut
 * sheet is a command its own host registers, so it needs no handler here.
 */
export function idleCommandHandlers(
  actions: IdleCommandActions,
): ReadonlyMap<DescriptorId, CommandPaletteHandler> {
  return new Map<DescriptorId, CommandPaletteHandler>([
    ["D5.new", () => actions.newChat()],
    ["S1.settings", () => actions.openSettings()],
    ["U0.themeSystem", () => actions.setTheme("system")],
    ["U0.themeLight", () => actions.setTheme("light")],
    ["U0.themeDark", () => actions.setTheme("dark")],
  ]);
}
