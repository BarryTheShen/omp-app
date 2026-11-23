import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseLauncherArgs } from "../../launcher/launcher";
import { PairingDesk } from "../pairing";
import { openDeviceAccess } from "./routes";

const IDENTITY = "MCowBQYDK2VwAyEAx7Q2vA1Sx8BdJ3uGQ0O1x7a8b9c0d1";
const HOST_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl";

let folder: string | null = null;
afterEach(async () => {
  if (folder !== null) await rm(folder, { recursive: true, force: true });
  folder = null;
});

async function access(home?: string) {
  folder = await mkdtemp(join(tmpdir(), "omp-app-enroll-"));
  const desk = new PairingDesk();
  const opened = await openDeviceAccess({
    appDataDir: folder,
    env: {
      XDG_RUNTIME_DIR: join(folder, "runtime"),
      ...(home === undefined ? {} : { HOME: home }),
    },
    serverOrigin: "https://app.example",
    desk,
    proxyCommand: ["omp-app", "device-ssh"],
    threadOfScope: () => null,
    onMachinesChanged: () => undefined,
    onActivity: () => undefined,
  });
  return { desk, opened };
}

describe("enrolling a machine (#20)", () => {
  test("takes a one-time pairing code once; a wrong code, a taken alias and a bad key are refused", async () => {
    const { desk, opened } = await access();
    const identityKey = IDENTITY.slice(0, 43);
    const ask = (code: string, alias: string) =>
      opened.enroll({ code, alias, identityKey, hostKey: HOST_KEY });
    expect(await ask("WRONG123", "laptop")).toEqual({ status: "refused", reason: "code" });
    const first = desk.newCode().code;
    const enrolled = await ask(first, "laptop");
    expect(enrolled.status).toBe("enrolled");
    // The code worked once.
    expect(await ask(first, "build-server")).toEqual({ status: "refused", reason: "code" });
    expect(await ask(desk.newCode().code, "laptop")).toEqual({
      status: "refused",
      reason: "alias-taken",
    });
    expect(await ask(desk.newCode().code, "x *")).toEqual({ status: "refused", reason: "code" });
    expect(opened.hub.machines().map((machine) => [machine.alias, machine.state])).toEqual([
      ["laptop", { on: false }],
    ]);
    opened.stop();
  });

  test("an alias the server account's ssh config already names is refused, and the code stays good", async () => {
    const home = await mkdtemp(join(tmpdir(), "omp-app-home-"));
    await Bun.write(
      join(home, ".ssh", "config"),
      "Host build-server\n  HostName 10.0.0.5\nHost *.lan !router\n  User me\n",
    );
    try {
      const { desk, opened } = await access(home);
      const code = desk.newCode().code;
      const ask = (alias: string) =>
        opened.enroll({ code, alias, identityKey: IDENTITY.slice(0, 43), hostKey: HOST_KEY });
      expect(await ask("build-server")).toEqual({ status: "refused", reason: "alias-taken" });
      expect((await ask("laptop")).status).toBe("enrolled");
      opened.stop();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("device-ssh takes one machine whose name an ssh config cannot read as a pattern", () => {
    expect(parseLauncherArgs(["device-ssh", "laptop"])).toMatchObject({
      ok: true,
      args: { command: "device-ssh", accessAlias: "laptop" },
    });
    for (const bad of [
      ["device-ssh"],
      ["device-ssh", "*"],
      ["device-ssh", "a", "b"],
      ["device-ssh", "-oProxyCommand=x"],
    ]) {
      expect(parseLauncherArgs(bad)).toMatchObject({ ok: false });
    }
  });

  test("a second server of the account (one started from a checkout) leaves the running server's agent access alone, and runs without it", async () => {
    const { opened } = await access();
    const runtime = join(folder ?? "", "runtime", "omp-app-access");
    const socket = join(runtime, "proxy.sock");
    const config = await Bun.file(join(runtime, "ssh_config")).text();
    const second = await mkdtemp(join(tmpdir(), "omp-app-second-"));
    try {
      await expect(
        openDeviceAccess({
          appDataDir: second,
          env: { XDG_RUNTIME_DIR: join(folder ?? "", "runtime") },
          serverOrigin: "https://app.example",
          desk: new PairingDesk(),
          proxyCommand: ["omp-app", "device-ssh"],
          threadOfScope: () => null,
          onMachinesChanged: () => undefined,
          onActivity: () => undefined,
        }),
      ).rejects.toThrow("another omp-app server of this account runs agent access");
      // The first server's socket still answers, and its ssh files are as it wrote them.
      const still = await Bun.connect({ unix: socket, socket: { data() {} } });
      still.end();
      expect(await Bun.file(join(runtime, "ssh_config")).text()).toBe(config);
    } finally {
      opened.stop();
      await rm(second, { recursive: true, force: true });
    }
  });
});
