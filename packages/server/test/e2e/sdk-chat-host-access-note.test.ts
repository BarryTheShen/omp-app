/**
 * What a chat is told about the computers agent access reaches (#20, PLAN §7e), end to end on the fake model provider:
 * the server names its access `ssh_config` in the chat's environment, and omp's system prompt holds the note, after
 * the person's own append prompt.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ACCESS_SSH_CONFIG_ENV } from "../../src/chat-host/access-note";
import { chatHostChats, PROGRAMS, realTest } from "./sdk-chat-host-harness";

const chats = chatHostChats();
const folders: string[] = [];
afterEach(async () => {
  await chats.stopAll();
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
}, 60_000);

const promptOf = async (chat: Awaited<ReturnType<typeof chats.start>>) =>
  ((await chat.client.request("get_state", {})) as { systemPrompt: string[] }).systemPrompt.join(
    "\n",
  );

describe("the computers a chat reaches through agent access", () => {
  for (const program of PROGRAMS) {
    const programTest = program.command === undefined ? test.skip : realTest;
    const command = program.command ?? [];

    programTest(
      `${program.name}: named in the system prompt after the person's own append prompt; nothing without them`,
      async () => {
        const folder = await mkdtemp(join(tmpdir(), "omp-access-note-e2e-"));
        folders.push(folder);
        const config = join(folder, "ssh_config");
        await writeFile(config, "Host laptop\n  HostName laptop\n  User omp-agent\n");
        const told = await chats.start(command, {
          args: ["--append-system-prompt", "Words the person appends."],
          env: { [ACCESS_SSH_CONFIG_ENV]: config },
        });
        const prompt = await promptOf(told);
        expect(prompt).toContain("Linked to this omp-app server: laptop.");
        expect(prompt).toContain(`ssh -F ${config} <name>`);
        expect(prompt.indexOf("Words the person appends.")).toBeGreaterThan(-1);
        expect(prompt.indexOf("Words the person appends.")).toBeLessThan(
          prompt.indexOf("Computers you can reach (omp-app agent access)"),
        );
        // Every chat is told how the app's messages are made, after the person's own append prompt.
        expect(prompt.indexOf("Words the person appends.")).toBeLessThan(
          prompt.indexOf("## Messages in omp-app"),
        );
        expect(prompt).toContain("`<app-notice source=");

        const untold = await chats.start(command);
        const plain = await promptOf(untold);
        expect(plain).not.toContain("omp-app agent access");
        expect(plain).toContain("## Messages in omp-app");
        expect(plain).toContain("`<host-context host=");
      },
      120_000,
    );
  }
});
