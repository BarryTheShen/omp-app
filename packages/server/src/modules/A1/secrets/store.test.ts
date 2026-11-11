import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildSecretObfuscator,
  getSecretPlaceholderKey,
} from "@oh-my-pi/pi-coding-agent/secrets/index";
import { AppFailure, type SecretsChanged } from "@omp-app/contracts";
import { YAML } from "bun";
import { type HideSecretsSetting, SecretStoreService } from "./store";

let root: string | null = null;
const stores: SecretStoreService[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) store.dispose();
  if (root !== null) await rm(root, { recursive: true, force: true });
  root = null;
});

/** Hide Secrets as a switch the test reads. */
function hideSecrets(on = false) {
  const listeners = new Set<() => void>();
  const state = { on, turnedOn: 0 };
  const setting: HideSecretsSetting = {
    isOn: async () => state.on,
    turnOn: async () => {
      state.turnedOn += 1;
      if (state.on) return;
      state.on = true;
      for (const listener of listeners) listener();
    },
    onChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return { setting, state };
}

/** An agent folder (maybe with a `secrets.yml`), and a key folder omp's placeholders are minted with. */
async function setup(file?: string) {
  root = await mkdtemp(join(tmpdir(), "omp-app-secrets-"));
  const agentDir = join(root, "agent");
  const keyDir = join(root, "keys");
  await mkdir(agentDir, { recursive: true });
  if (file !== undefined) await writeFile(join(agentDir, "secrets.yml"), file);
  const hide = hideSecrets();
  const make = () => {
    const store = new SecretStoreService({
      agentDir,
      hideSecrets: hide.setting,
      placeholderKey: () => getSecretPlaceholderKey(keyDir),
    });
    stores.push(store);
    return store;
  };
  /** What a chat's omp loads from these files, as the chat host builds it. */
  const chatObfuscator = async () => {
    const built = await buildSecretObfuscator(join(root as string, "project"), agentDir, keyDir);
    if (built === undefined) throw new Error("omp loaded no secrets");
    return built;
  };
  const fileText = () => readFile(join(agentDir, "secrets.yml"), "utf8");
  return { store: make(), make, hide, chatObfuscator, fileText, agentDir };
}

const failureOf = async (run: Promise<unknown>): Promise<string> => {
  try {
    await run;
  } catch (failure) {
    if (failure instanceof AppFailure) return failure.appError.message;
    throw failure;
  }
  throw new Error("expected a refusal");
};

describe("the secrets of omp's Hide Secrets", () => {
  test("a saved secret's placeholder is what a chat's omp shows the AI, and turns back into the value in a command", async () => {
    const { store, chatObfuscator } = await setup();
    const saved = await store.add({
      name: "AMO_JWT_SECRET",
      value: "s3cr3t-value-0123456789abcdef",
    });
    // omp's placeholder: the name's letters and digits, a code, and a hint of the value's case (`:L`, lower case).
    expect(saved.placeholder).toMatch(/^\$\$AMOJWTSECRET_[A-Z0-9]+(?::[ULCM])?\$\$$/);
    expect(saved.length).toBe("s3cr3t-value-0123456789abcdef".length);
    const chat = await chatObfuscator();
    const output = "token: s3cr3t-value-0123456789abcdef";
    expect(chat.obfuscate(output)).toBe(`token: ${saved.placeholder}`);
    expect(chat.deobfuscate(`gh secret set X --body "${saved.placeholder}"`)).toBe(
      'gh secret set X --body "s3cr3t-value-0123456789abcdef"',
    );
    expect((await store.list()).secrets).toEqual([saved]);
  });

  test("saving keeps the file's other entries, reads only to its owner, and turns Hide Secrets on", async () => {
    const { store, hide, fileText, agentDir } = await setup(
      YAML.stringify([{ type: "regex", content: "tok_[a-z0-9]{12}", mode: "obfuscate" }]),
    );
    expect((await store.list()).hidden).toBe(false);
    await store.add({ name: "deploy-key", value: "  0123456789abcdefghij\n" });
    expect(hide.state.on).toBe(true);
    const entries = YAML.parse(await fileText()) as Record<string, unknown>[];
    expect(entries).toEqual([
      { type: "regex", content: "tok_[a-z0-9]{12}", mode: "obfuscate" },
      // Trimmed: a value from a command ends in a line break, and would be hidden only where it appears with one.
      {
        type: "plain",
        content: "0123456789abcdefghij",
        mode: "obfuscate",
        friendlyName: "deploy-key",
      },
    ]);
    expect((await stat(join(agentDir, "secrets.yml"))).mode & 0o777).toBe(0o600);
    const list = await store.list();
    expect(list.others).toBe(1);
    expect(list.hidden).toBe(true);
    expect(list.secrets.map((secret) => secret.name)).toEqual(["deploy-key"]);
  });

  test("a name taken, a name the AI would read the same, a value saved already, or a short value is refused", async () => {
    const { store } = await setup();
    await store.add({ name: "GITHUB_TOKEN", value: "ghp_aaaaaaaaaaaaaaaaaaaa" });
    expect(await failureOf(store.add({ name: "github_token", value: "another-value-123" }))).toBe(
      "A secret named GITHUB_TOKEN is already saved: remove it first to replace it.",
    );
    expect(await failureOf(store.add({ name: "GITHUB-TOKEN", value: "another-value-123" }))).toBe(
      "GITHUB-TOKEN would read like GITHUB_TOKEN to the AI: pick another name.",
    );
    expect(await failureOf(store.add({ name: "COPY", value: "ghp_aaaaaaaaaaaaaaaaaaaa" }))).toBe(
      "This value is already saved, as GITHUB_TOKEN.",
    );
    expect(await failureOf(store.add({ name: "SHORT", value: " abc      " }))).toBe(
      "omp hides secrets of 8 characters or more.",
    );
    expect((await store.list()).secrets.map((secret) => secret.name)).toEqual(["GITHUB_TOKEN"]);
  });

  test("reveal gives the value; remove takes out only that secret", async () => {
    const { store, fileText } = await setup(
      YAML.stringify([{ type: "plain", content: "hand-written-secret" }]),
    );
    await store.add({ name: "ONE", value: "first-secret-value" });
    await store.add({ name: "TWO", value: "second-secret-value" });
    expect(await store.reveal({ name: "TWO" })).toEqual({ value: "second-secret-value" });
    await store.remove({ name: "ONE" });
    expect(await failureOf(store.reveal({ name: "ONE" }))).toBe("No secret is named ONE.");
    expect(await failureOf(store.remove({ name: "ONE" }))).toBe("No secret is named ONE.");
    const entries = YAML.parse(await fileText()) as Record<string, unknown>[];
    expect(entries.map((entry) => entry.content)).toEqual([
      "hand-written-secret",
      "second-secret-value",
    ]);
  });

  test("a file omp cannot read is never written over", async () => {
    const broken = "type: plain\ncontent: not-a-list\n";
    const { store, fileText } = await setup(broken);
    expect(await failureOf(store.list())).toContain(
      "is not a list, as omp needs: fix it by hand first.",
    );
    expect(await failureOf(store.add({ name: "X1", value: "some-secret-value" }))).toContain(
      "is not a list",
    );
    expect(await fileText()).toBe(broken);
  });

  test("a change from anywhere reaches listeners with the names it added, and two writers at once both land", async () => {
    const { store, make } = await setup();
    await store.add({ name: "BEFORE", value: "saved-before-listening" });
    const changes: SecretsChanged[] = [];
    store.subscribe((changed) => changes.push(changed));
    // Another process (`omp-app secret add` in a chat) and this one, at the same moment.
    const other = make();
    await Promise.all([
      other.add({ name: "FROM_A_CHAT", value: "made-by-a-command-0001" }),
      store.add({ name: "FROM_A_PAGE", value: "pasted-on-a-page-0002" }),
    ]);
    expect((await store.list()).secrets.map((secret) => secret.name).sort()).toEqual([
      "BEFORE",
      "FROM_A_CHAT",
      "FROM_A_PAGE",
    ]);
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline && changes.flatMap((change) => change.added).length < 2)
      await Bun.sleep(20);
    expect(changes.flatMap((change) => change.added).sort()).toEqual([
      "FROM_A_CHAT",
      "FROM_A_PAGE",
    ]);
    expect(changes.at(-1)?.list.secrets).toHaveLength(3);
  });
});
