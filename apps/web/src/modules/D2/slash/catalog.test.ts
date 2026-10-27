import { AppFailure, type CapabilityMap, ThreadId } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import { createSlashCommandCatalog } from "./catalog";
import { fakeSlashClient, REAL_COMMAND_LIST } from "./test-support";

const threadId = ThreadId.parse("thread-d23-catalog");
const available: CapabilityMap = {
  "omp.cmd.get_available_commands": { state: "available", via: "rpc" },
};

describe("D2.3 slash command catalog", () => {
  test("reads omp's real command list and follows the host's live updates", async () => {
    const fake = fakeSlashClient();
    const catalog = createSlashCommandCatalog({
      client: fake.client,
      threadId,
      capabilities: () => available,
    });
    const commands = await catalog.refresh();

    expect(commands).toHaveLength(REAL_COMMAND_LIST.length);
    expect(catalog.getSnapshot()).toMatchObject({ state: "ready" });
    expect(commands.find((command) => command.name === "model")?.aliases).toEqual(["models"]);
    expect(commands.find((command) => command.name === "usage")?.subcommands?.[0]?.name).toBe(
      "show",
    );

    fake.emitEvent({
      type: "available_commands",
      commands: [{ name: "live-skill", source: "skill", description: "Pushed by omp" }],
    });
    expect(catalog.getSnapshot().commands.map((command) => command.name)).toEqual(["live-skill"]);
    expect(catalog.getSnapshot().state).toBe("ready");

    catalog.dispose();
    expect(fake.unsubscribed()).toBe(1);
  });

  test("fails closed without the capability: nothing is sent and the state says unavailable", async () => {
    const fake = fakeSlashClient();
    const catalog = createSlashCommandCatalog({
      client: fake.client,
      threadId,
      capabilities: () => ({}),
    });

    await expect(catalog.refresh()).rejects.toBeInstanceOf(AppFailure);
    expect(catalog.getSnapshot()).toMatchObject({
      state: "unavailable",
      commands: [],
      error: { state: "unavailable", error: { code: "unavailable" } },
    });
    expect(fake.sent).toEqual([]);
    catalog.dispose();
  });

  test("keeps the last good list and records the failure when a later read fails", async () => {
    let failNext = false;
    const fake = fakeSlashClient({
      commands: async () => {
        if (failNext)
          throw new AppFailure({
            code: "internal",
            message: "omp did not answer.",
            retryable: true,
          });
        return { commands: REAL_COMMAND_LIST };
      },
    });
    const catalog = createSlashCommandCatalog({
      client: fake.client,
      threadId,
      capabilities: () => available,
    });
    await catalog.refresh();
    failNext = true;

    await expect(catalog.refresh()).rejects.toBeInstanceOf(AppFailure);
    expect(catalog.getSnapshot()).toMatchObject({
      state: "stale",
      error: { state: "error", error: { message: "omp did not answer." } },
    });
    expect(catalog.getSnapshot().commands).toHaveLength(REAL_COMMAND_LIST.length);
    catalog.dispose();
  });

  test("ignores a reply that was requested before a live update, because the update is newer", async () => {
    const pending = Promise.withResolvers<unknown>();
    let reply: "immediate" | "pending" = "immediate";
    const fake = fakeSlashClient({
      commands: () =>
        reply === "immediate" ? Promise.resolve({ commands: REAL_COMMAND_LIST }) : pending.promise,
    });
    const catalog = createSlashCommandCatalog({
      client: fake.client,
      threadId,
      capabilities: () => available,
    });
    await catalog.refresh();

    reply = "pending";
    const second = catalog.refresh();
    fake.emitEvent({
      type: "available_commands",
      commands: [{ name: "newer", source: "custom" }],
    });
    pending.resolve({ commands: [{ name: "older", source: "builtin" }] });

    await second;
    expect(catalog.getSnapshot().commands.map((command) => command.name)).toEqual(["newer"]);
    catalog.dispose();
  });

  test("one request serves every caller while it is in flight", async () => {
    const fake = fakeSlashClient();
    const catalog = createSlashCommandCatalog({
      client: fake.client,
      threadId,
      capabilities: () => available,
    });
    const [first, second] = await Promise.all([catalog.refresh(), catalog.refresh()]);

    expect(first).toEqual(second);
    expect(fake.sent).toEqual(["get_available_commands"]);
    catalog.dispose();
  });

  test("a cancelled wait rejects with a cancellation and leaves the list as it was", async () => {
    const never = Promise.withResolvers<unknown>();
    let reply: "immediate" | "never" = "immediate";
    const fake = fakeSlashClient({
      commands: () =>
        reply === "immediate" ? Promise.resolve({ commands: REAL_COMMAND_LIST }) : never.promise,
    });
    const catalog = createSlashCommandCatalog({
      client: fake.client,
      threadId,
      capabilities: () => available,
    });
    await catalog.refresh();

    reply = "never";
    const controller = new AbortController();
    const waiting = catalog.refresh({ signal: controller.signal });
    controller.abort();

    await expect(waiting).rejects.toMatchObject({ appError: { code: "cancelled" } });
    expect(catalog.getSnapshot().commands).toHaveLength(REAL_COMMAND_LIST.length);
    catalog.dispose();
  });

  test("after dispose, no listener hears a later update", async () => {
    const fake = fakeSlashClient();
    const catalog = createSlashCommandCatalog({
      client: fake.client,
      threadId,
      capabilities: () => available,
    });
    await catalog.refresh();
    const heard: number[] = [];
    catalog.subscribe((snapshot) => heard.push(snapshot.commands.length));
    const before = heard.length;

    catalog.dispose();
    fake.emitEvent({ type: "available_commands", commands: [] });

    expect(heard).toHaveLength(before);
  });
});
