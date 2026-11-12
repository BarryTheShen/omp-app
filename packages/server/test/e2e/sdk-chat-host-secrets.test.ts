/**
 * Secrets saved while a chat runs (`secrets_live`), end to end on the fake model provider: omp reads `secrets.yml`
 * once, when a chat starts; a secret the app saves later is hidden from the chat's AI at once, and a command with its
 * placeholder runs with its value. The fake model calls a tool with `call_tool bash <json>`, then says what the tool
 * gave it ("tool said: …"): the chat's file keeps the model's words as the model wrote them, placeholders and all.
 * And every secret stays hidden in the agent's own notes (`secrets_every_message`), which omp's hiding passes over: the
 * fake provider logs every request it gets (`requests.jsonl`). Runs from source and compiled (`sdk-chat-host-harness.ts`).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { YAML } from "bun";
import { chatHostChats, lastReply, PROGRAMS, realTest, resultOf } from "./sdk-chat-host-harness";

const chats = chatHostChats();
afterEach(() => chats.stopAll(), 60_000);

const STORE = resolve(import.meta.dir, "../../src/modules/A1/secrets/store.ts");

/**
 * Runs `script` with `store`, a `SecretStoreService` made the way the app makes it (Settings → Providers → Secrets,
 * `omp-app secret`), in another process with the chat's own folders, and gives back what the script writes.
 */
async function withStore(
  folder: string,
  script: string,
  env: Record<string, string>,
): Promise<string> {
  const scratch = await mkdtemp(join(tmpdir(), "omp-app-save-secret-"));
  try {
    const file = join(scratch, "store.ts");
    await writeFile(
      file,
      `import { SecretStoreService } from ${JSON.stringify(STORE)};
const store = new SecretStoreService({
  agentDir: process.env.PI_CODING_AGENT_DIR,
  hideSecrets: { isOn: async () => true, turnOn: async () => {}, onChange: () => () => {} },
});
${script}
`,
    );
    const root = dirname(folder);
    const running = Bun.spawn(["bun", file], {
      env: {
        ...Bun.env,
        HOME: join(root, "home"),
        PI_CODING_AGENT_DIR: join(root, "agent"),
        ...env,
      },
      stdout: "pipe",
      stderr: "inherit",
    });
    const written = await new Response(running.stdout).text();
    if ((await running.exited) !== 0) throw new Error("the secrets store failed");
    return written;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** Saves a secret as the app does, and gives back the placeholder the app shows for it. */
async function saveSecret(folder: string, name: string, value: string): Promise<string> {
  const placeholder = await withStore(
    folder,
    `const saved = await store.add({ name: process.env.SECRET_NAME, value: process.env.SECRET_VALUE });
process.stdout.write(saved.placeholder ?? "");`,
    { SECRET_NAME: name, SECRET_VALUE: value },
  );
  if (placeholder === "") throw new Error("the secret was not saved");
  return placeholder;
}

/** The placeholder the app lists for a saved secret. */
async function placeholderOf(folder: string, name: string): Promise<string> {
  const placeholder = await withStore(
    folder,
    `const listed = await store.list();
process.stdout.write(listed.secrets.find((secret) => secret.name === process.env.SECRET_NAME)?.placeholder ?? "");`,
    { SECRET_NAME: name },
  );
  if (placeholder === "") throw new Error(`no placeholder is listed for ${name}`);
  return placeholder;
}

/** Every request body the fake provider got for this chat: all the model was sent. */
async function sentToModel(folder: string): Promise<{ messages: unknown[] }[]> {
  const log = await readFile(join(dirname(folder), "requests.jsonl"), "utf8");
  return log
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as { messages: unknown[] });
}

/** Every line of the chat's files under its agent folder: the model's messages as omp keeps them. */
async function sessionText(folder: string): Promise<string> {
  const agentDir = join(dirname(folder), "agent");
  let text = "";
  for await (const file of new Bun.Glob("sessions/**/*.jsonl").scan({ cwd: agentDir })) {
    text += await readFile(join(agentDir, file), "utf8");
  }
  return text;
}

describe("a secret saved while a chat runs", () => {
  for (const program of PROGRAMS) {
    const programTest = program.command === undefined ? test.skip : realTest;
    const command = program.command ?? [];

    programTest(
      `${program.name}: is hidden from the chat's AI at once, and a command with its placeholder runs with the value`,
      async () => {
        const old = "old-secret-known-at-start-0123";
        const chat = await chats.start(command, {
          config: "secrets:\n  enabled: true\n",
          agentFiles: {
            "secrets.yml": YAML.stringify([
              { type: "plain", content: old, mode: "obfuscate", friendlyName: "OLD_ONE" },
            ]),
          },
        });
        const hello = await chat.client.hello;
        expect(hello.features ?? []).toContain("secrets_live");

        const value = "new-secret-saved-later-4567";
        const placeholder = await saveSecret(chat.folder, "NEW_TOKEN", value);
        expect(placeholder).toMatch(/^\$\$NEWTOKEN_[A-Z0-9]+(?::[ULCM])?\$\$$/);
        // The host reads the file again a moment after it changes.
        await Bun.sleep(500);

        const run = `printf %s '${placeholder}' > out.txt; cat out.txt`;
        await chat.client.request("prompt", {
          text: `call_tool bash ${JSON.stringify({ command: run })}`,
        });
        await chat.next(resultOf("1"));
        // The command ran with the value.
        expect(await readFile(join(chat.folder, "out.txt"), "utf8")).toBe(value);
        // The AI got the command's output as the placeholder: its reply, as omp keeps it, never holds the value.
        const kept = await sessionText(chat.folder);
        expect(kept).toContain(`tool said: ${placeholder}`);
        expect(kept).not.toContain(`tool said: ${value}`);
      },
      60_000,
    );

    programTest(
      `${program.name}: a secret removed while the chat runs is not filled in any more`,
      async () => {
        // Known when the chat starts: omp's own obfuscator keeps it after the file loses it.
        const value = "removed-later-secret-2468";
        const chat = await chats.start(command, {
          config: "secrets:\n  enabled: true\n",
          agentFiles: {
            "secrets.yml": YAML.stringify([
              { type: "plain", content: value, mode: "obfuscate", friendlyName: "GONE_SOON" },
            ]),
          },
        });
        const hello = await chat.client.hello;
        expect(hello.features ?? []).toContain("secrets_removed");
        const placeholder = await placeholderOf(chat.folder, "GONE_SOON");
        await withStore(chat.folder, "await store.remove({ name: process.env.SECRET_NAME });", {
          SECRET_NAME: "GONE_SOON",
        });
        // The host reads the file again a moment after it changes.
        await Bun.sleep(500);

        const run = `printf %s '${placeholder}' > gone.txt`;
        await chat.client.request("prompt", {
          text: `call_tool bash ${JSON.stringify({ command: run })}`,
        });
        await chat.next(resultOf("1"));
        // The call is refused before it runs, and the AI is told why.
        expect(await Bun.file(join(chat.folder, "gone.txt")).exists()).toBe(false);
        expect(lastReply(chat)).toContain("GONE_SOON, which has been removed");
      },
      60_000,
    );

    programTest(
      `${program.name}: a saved value is hidden even where omp's own hiding never looks, as in the system prompt`,
      async () => {
        const value = "in-the-system-prompt-1357";
        const chat = await chats.start(command, {
          config: "secrets:\n  enabled: true\n",
          // omp hides secrets in the conversation only; its system prompt and tool schemas go out as they are.
          args: ["--append-system-prompt", `The deploy key is ${value}.`],
          agentFiles: {
            "secrets.yml": YAML.stringify([
              { type: "plain", content: value, mode: "obfuscate", friendlyName: "DEPLOY_KEY" },
            ]),
          },
        });
        await chat.client.hello;
        const placeholder = await placeholderOf(chat.folder, "DEPLOY_KEY");
        await chat.client.request("prompt", { text: "hello" });
        await chat.next(resultOf("1"));

        const sent = JSON.stringify(await sentToModel(chat.folder));
        expect(sent).toContain(`The deploy key is ${placeholder}.`);
        expect(sent).not.toContain(value);
      },
      60_000,
    );

    programTest(
      `${program.name}: every secret stays hidden in a finished background job's note, which quotes its command and output`,
      async () => {
        // Known when the chat starts: omp's own hiding has it, and passes over the agent's notes.
        const value = "known-at-start-secret-8910";
        const chat = await chats.start(command, {
          config: "secrets:\n  enabled: true\n",
          agentFiles: {
            "secrets.yml": YAML.stringify([
              { type: "plain", content: value, mode: "obfuscate", friendlyName: "KNOWN_ONE" },
            ]),
          },
        });
        const hello = await chat.client.hello;
        expect(hello.features ?? []).toContain("secrets_every_message");
        const placeholder = await placeholderOf(chat.folder, "KNOWN_ONE");

        const run = `printf %s '${placeholder}' > job.txt; cat job.txt`;
        await chat.client.request("prompt", {
          text: `call_tool bash ${JSON.stringify({ command: run, async: true })}`,
        });
        await chat.next(resultOf("1"));
        // The job ends at once; its note starts a turn of its own, and the chat settles after that turn.
        await chat.next((event) => event.type === "session_settled");
        expect(await readFile(join(chat.folder, "job.txt"), "utf8")).toBe(value);

        const sent = await sentToModel(chat.folder);
        const notes = sent
          .flatMap((request) => request.messages)
          .map((message) => JSON.stringify(message))
          .filter((message) => message.includes("has completed"));
        // The note went out, naming the job by its command and giving its output, with the placeholder for the value.
        expect(notes.length).toBeGreaterThan(0);
        for (const note of notes) expect(note).toContain(placeholder);
        expect(JSON.stringify(sent)).not.toContain(value);
      },
      60_000,
    );
  }
});
