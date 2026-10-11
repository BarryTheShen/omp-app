import type { DescriptorId } from "@omp-app/contracts";
import { describe, expect, test, vi } from "vitest";
import { DESCRIPTORS } from "@/registry";
import { idleCommandHandlers } from "./idle-commands";

function actions() {
  return { newChat: vi.fn(), openSettings: vi.fn(), setTheme: vi.fn() };
}

describe("the command palette with no chat open", () => {
  test("offers only the commands that need no chat: New chat, Settings and the three themes", () => {
    const handlers = idleCommandHandlers(actions());
    expect([...handlers.keys()]).toEqual([
      "D5.new",
      "S1.settings",
      "U0.themeSystem",
      "U0.themeLight",
      "U0.themeDark",
    ]);
  });

  test("each idle command runs its own app action", async () => {
    const app = actions();
    const handlers = idleCommandHandlers(app);
    await handlers.get("D5.new")?.();
    handlers.get("S1.settings")?.();
    handlers.get("U0.themeSystem")?.();
    handlers.get("U0.themeLight")?.();
    handlers.get("U0.themeDark")?.();
    expect(app.newChat).toHaveBeenCalledOnce();
    expect(app.openSettings).toHaveBeenCalledOnce();
    expect(app.setTheme.mock.calls).toEqual([["system"], ["light"], ["dark"]]);
  });

  test("every idle command is a command the registry defines", () => {
    const commands = new Set<DescriptorId>(
      DESCRIPTORS.filter((descriptor) => descriptor.kind === "command").map(
        (descriptor) => descriptor.id,
      ),
    );
    for (const id of idleCommandHandlers(actions()).keys()) {
      expect(commands.has(id), id).toBe(true);
    }
  });
});
