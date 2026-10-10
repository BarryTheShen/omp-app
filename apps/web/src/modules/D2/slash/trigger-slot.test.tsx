import {
  AssistantRuntimeProvider,
  type ThreadMessage,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import type { CapabilityMap } from "@omp-app/contracts";
import { ThreadId } from "@omp-app/contracts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ComposerSurface } from "../../U2/composer/composer";
import { createSlashCommandProvider, type SlashCommandProvider } from "./provider";
import { fakeSlashClient } from "./test-support";
import { SlashTriggerSlot } from "./trigger-slot";

function RuntimeHarness({ children }: { readonly children: ReactNode }) {
  const runtime = useExternalStoreRuntime({
    messages: [] as readonly ThreadMessage[],
    onNew: async () => undefined,
    onCancel: async () => undefined,
  });
  return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>;
}

afterEach(() => cleanup());

const threadId = ThreadId.parse("thread-d23-trigger");

function providerWith(capabilities: CapabilityMap): SlashCommandProvider {
  const fake = fakeSlashClient();
  return createSlashCommandProvider({
    client: fake.client,
    threadId,
    capabilities: () => capabilities,
  });
}

const available: CapabilityMap = {
  "omp.cmd.get_available_commands": { state: "available", via: "rpc" },
};

describe("D2.3 SlashTriggerSlot", () => {
  test("opens omp's commands with their source, description and argument hint, and inserts one", async () => {
    const provider = providerWith(available);
    const selected = vi.fn();
    render(
      <RuntimeHarness>
        <SlashTriggerSlot providers={[provider]} onSelect={selected}>
          <ComposerSurface submitPrompt={async () => undefined} cancel={() => undefined} />
        </SlashTriggerSlot>
      </RuntimeHarness>,
    );

    const input = screen.getByRole("textbox", { name: "Message input" });
    fireEvent.change(input, { target: { value: "/us" } });
    (input as HTMLTextAreaElement).setSelectionRange(3, 3);
    await waitFor(() => expect(screen.getByRole("listbox")).toBeTruthy());
    await waitFor(() => expect(screen.getByText("/usage")).toBeTruthy());
    expect(screen.getByText("Show token usage")).toBeTruthy();
    expect(screen.getAllByText("Built-in").length).toBeGreaterThan(0);
    expect(screen.getByText(/Arguments: \[show\|reset/)).toBeTruthy();
    await waitFor(() => expect(input.getAttribute("aria-activedescendant")).not.toBeNull());
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(selected).toHaveBeenCalledTimes(1));
    expect(selected).toHaveBeenCalledWith(expect.objectContaining({ id: "slash:builtin:usage" }));
    expect((input as HTMLTextAreaElement).value).toBe("/usage ");
    provider.dispose();
  });

  test("with omp's list unavailable, the app's command is still offered and the reason is shown plainly", async () => {
    const provider = createSlashCommandProvider({
      client: fakeSlashClient().client,
      threadId,
      capabilities: () => ({}),
      appCommands: () => [{ name: "new", description: "Start a new chat", run: async () => ({}) }],
    });
    render(
      <RuntimeHarness>
        <SlashTriggerSlot providers={[provider]} onSelect={() => undefined}>
          <ComposerSurface submitPrompt={async () => undefined} cancel={() => undefined} />
        </SlashTriggerSlot>
      </RuntimeHarness>,
    );

    const input = screen.getByRole("textbox", { name: "Message input" });
    fireEvent.change(input, { target: { value: "/" } });
    (input as HTMLTextAreaElement).setSelectionRange(1, 1);
    await waitFor(() => expect(screen.getByText("/new")).toBeTruthy());
    expect(screen.getByText("Slash commands are unavailable in this omp session.")).toBeTruthy();
    provider.dispose();
  });

  test("Escape closes the command list without changing the message", async () => {
    const provider = providerWith(available);
    render(
      <RuntimeHarness>
        <SlashTriggerSlot providers={[provider]} onSelect={() => undefined}>
          <ComposerSurface submitPrompt={async () => undefined} cancel={() => undefined} />
        </SlashTriggerSlot>
      </RuntimeHarness>,
    );

    const input = screen.getByRole("textbox", { name: "Message input" });
    fireEvent.change(input, { target: { value: "/usa" } });
    (input as HTMLTextAreaElement).setSelectionRange(4, 4);
    await waitFor(() => expect(screen.getByRole("listbox")).toBeTruthy());
    fireEvent.keyDown(input, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
    expect((input as HTMLTextAreaElement).value).toBe("/usa");
    provider.dispose();
  });

  test("a message that does not start with the slash opens no command list", async () => {
    const provider = providerWith(available);
    render(
      <RuntimeHarness>
        <SlashTriggerSlot providers={[provider]} onSelect={() => undefined}>
          <ComposerSurface submitPrompt={async () => undefined} cancel={() => undefined} />
        </SlashTriggerSlot>
      </RuntimeHarness>,
    );

    const input = screen.getByRole("textbox", { name: "Message input" });
    fireEvent.change(input, { target: { value: " /usage" } });
    (input as HTMLTextAreaElement).setSelectionRange(7, 7);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(screen.queryByRole("listbox")).toBeNull();
    provider.dispose();
  });

  test("a command with no arguments is quiet once chosen: an Enter pressed at once sends the message", async () => {
    const provider = createSlashCommandProvider({
      client: fakeSlashClient().client,
      threadId,
      capabilities: () => available,
      appCommands: () => [{ name: "login", description: "Sign in", run: async () => ({}) }],
    });
    const submitPrompt = vi.fn(async () => undefined);
    render(
      <RuntimeHarness>
        <SlashTriggerSlot providers={[provider]} onSelect={() => undefined}>
          <ComposerSurface submitPrompt={submitPrompt} cancel={() => undefined} />
        </SlashTriggerSlot>
      </RuntimeHarness>,
    );
    const input = screen.getByRole("textbox", { name: "Message input" }) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "/login" } });
    input.setSelectionRange(6, 6);
    await waitFor(() => expect(input.getAttribute("aria-activedescendant")).not.toBeNull());
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(input.value).toBe("/login "));

    // The option that was chosen is still in the list until the next search answers. It must not take this Enter.
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(submitPrompt).toHaveBeenCalledTimes(1));
    provider.dispose();
  });

  test("once the list has settled after a no-argument command, the next Enter sends too", async () => {
    const provider = createSlashCommandProvider({
      client: fakeSlashClient().client,
      threadId,
      capabilities: () => available,
      appCommands: () => [{ name: "login", description: "Sign in", run: async () => ({}) }],
    });
    const submitPrompt = vi.fn(async () => undefined);
    render(
      <RuntimeHarness>
        <SlashTriggerSlot providers={[provider]} onSelect={() => undefined}>
          <ComposerSurface submitPrompt={submitPrompt} cancel={() => undefined} />
        </SlashTriggerSlot>
      </RuntimeHarness>,
    );
    const input = screen.getByRole("textbox", { name: "Message input" }) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "/login" } });
    input.setSelectionRange(6, 6);
    await waitFor(() => expect(input.getAttribute("aria-activedescendant")).not.toBeNull());
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(input.value).toBe("/login "));
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 400);
    await promise;
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(submitPrompt).toHaveBeenCalledTimes(1));
    provider.dispose();
  });
});
