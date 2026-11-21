import { afterEach, expect, test } from "bun:test";
import { createECDH, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PushDevices } from "@omp-app/contracts";
import { PushService } from "./service";

let dir: string | undefined;
afterEach(async () => {
  if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

const subscription = (endpoint: string, device: string) => {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return {
    endpoint,
    keys: {
      p256dh: ecdh.getPublicKey().toString("base64url"),
      auth: randomBytes(16).toString("base64url"),
    },
    device,
  };
};

test("devices subscribe and leave; a push reaches each, and a device its push service says is gone is dropped", async () => {
  dir = await mkdtemp(join(tmpdir(), "omp-app-push-"));
  const file = join(dir, "push.json");
  const posted: { url: string; headers: Record<string, string> }[] = [];
  const service = new PushService({
    file,
    fetch: async (url, init) => {
      posted.push({ url, headers: init.headers as Record<string, string> });
      return new Response("", { status: url.includes("gone") ? 410 : 201 });
    },
  });
  const key = await service.publicKey();
  expect(Buffer.from(key, "base64url")).toHaveLength(65);
  // The file holds the private key and the devices: owner-only.
  if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);

  await service.subscribe(subscription("https://web.push.apple.com/phone", "iPhone"));
  // The same device again replaces itself.
  await service.subscribe(subscription("https://web.push.apple.com/phone", "iPhone"));
  const listed = await service.subscribe(
    subscription("https://updates.push.services.mozilla.com/gone", "Old laptop"),
  );
  expect(PushDevices.parse(listed).devices.map((each) => each.device)).toEqual([
    "iPhone",
    "Old laptop",
  ]);
  // Nothing that would let anyone push is listed.
  expect(JSON.stringify(listed)).not.toContain("push.apple.com");

  expect(
    await service.send({
      title: "A question waits",
      body: "Fix the build",
      chat: "t-1",
      tag: "question-t-1",
    }),
  ).toEqual({
    sent: 1,
    failed: 1,
  });
  expect(posted.map((each) => each.url).sort()).toEqual([
    "https://updates.push.services.mozilla.com/gone",
    "https://web.push.apple.com/phone",
  ]);
  expect(posted[0]?.headers.authorization).toContain(`k=${key}`);
  expect(posted[0]?.headers.topic).toHaveLength(32);
  expect((await service.devices()).devices.map((each) => each.device)).toEqual(["iPhone"]);

  // The keys stay across a restart: devices subscribed with this key keep working.
  expect(await new PushService({ file }).publicKey()).toBe(key);
  const id = (await service.devices()).devices[0]?.id ?? "";
  expect((await service.unsubscribe({ id })).devices).toEqual([]);
  expect(JSON.parse(await readFile(file, "utf8")).devices).toEqual([]);
});
