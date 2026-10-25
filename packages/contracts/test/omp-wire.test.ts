import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { OMP_COMMAND_NAMES, OMP_COMMANDS, OMP_WIRE_COMMIT, OMP_WIRE_TAG } from "../src";

const PACKAGE = join(import.meta.dir, "..");
const WIRE = join(PACKAGE, "src", "omp-wire");

interface WireSchema {
  "x-rpc": {
    notification: string;
    sessionEvent: string;
    serverFrame: string;
    inbound: string;
    commands: Array<{ name: string; completion: string | null; timeoutMs: number | null }>;
  };
}

const schema = (await Bun.file(join(WIRE, "rpc-wire.schema.json")).json()) as WireSchema;
const provenance = await Bun.file(join(WIRE, "PROVENANCE.md")).text();
const rows = [
  ...provenance.matchAll(/^\| `([^`]+)` \| (\S+) \| `([0-9a-f]{64})` \| (\d+) \|$/gm),
].map(([, file = "", url = "", sha256 = "", bytes = ""]) => ({
  file,
  url,
  sha256,
  bytes: Number(bytes),
}));

describe("copied omp wire files", () => {
  test("PROVENANCE.md lists the three copied files", () => {
    expect(rows.map((row) => row.file).sort()).toEqual([
      "LICENSE",
      "rpc-wire.generated.ts",
      "rpc-wire.schema.json",
    ]);
  });

  test("each file matches its recorded sha256 and size", async () => {
    for (const row of rows) {
      const bytes = await Bun.file(join(WIRE, row.file)).bytes();
      expect(new Bun.CryptoHasher("sha256").update(bytes).digest("hex")).toBe(row.sha256);
      expect(bytes.byteLength).toBe(row.bytes);
    }
  });

  test("the copy comes from the wire tag and commit omp.ts names", () => {
    expect(provenance).toContain(`- Tag: \`${OMP_WIRE_TAG}\``);
    expect(provenance).toContain(`- Commit: \`${OMP_WIRE_COMMIT}\``);
    for (const row of rows) expect(row.url).toContain(`/${OMP_WIRE_COMMIT}/`);
  });

  test("the generated file declares types only and imports nothing", async () => {
    const generated = await Bun.file(join(WIRE, "rpc-wire.generated.ts")).text();
    const exports = generated.split("\n").filter((line) => line.startsWith("export "));
    expect(exports.length).toBeGreaterThan(0);
    expect(exports.filter((line) => !/^export (?:type|interface) /.test(line))).toEqual([]);
    expect(generated).not.toMatch(/^import /m);
  });

  test("the package exports resolve to existing files", async () => {
    const manifest = (await Bun.file(join(PACKAGE, "package.json")).json()) as {
      exports: Record<string, string>;
    };
    expect(manifest.exports).toEqual({
      ".": "./src/index.ts",
      // The ids alone, without the barrel's JSON inventory, for files that e2e specs load in Node (#2638).
      "./ids": "./src/core/ids.ts",
      "./omp-wire/schema.json": "./src/omp-wire/rpc-wire.schema.json",
    });
    for (const target of Object.values(manifest.exports)) {
      expect(await Bun.file(join(PACKAGE, target)).exists()).toBe(true);
    }
  });
});

describe("OMP_COMMANDS", () => {
  const commands = schema["x-rpc"].commands;

  test("has exactly the commands of x-rpc.commands", () => {
    expect(new Set(commands.map((command) => command.name))).toEqual(
      new Set<string>(OMP_COMMAND_NAMES),
    );
    expect(OMP_COMMAND_NAMES).toHaveLength(commands.length);
  });

  test("matches completion and timeoutMs per command", () => {
    for (const { name, completion, timeoutMs } of commands) {
      const spec: { completion: string | null; timeoutMs: number | null } | undefined =
        OMP_COMMANDS[name as keyof typeof OMP_COMMANDS];
      expect({ name, ...spec }).toEqual({ name, completion, timeoutMs });
    }
  });

  test("the frame unions omp.ts aliases are the ones x-rpc names", () => {
    expect(schema["x-rpc"]).toMatchObject({
      notification: "RpcNotification",
      sessionEvent: "RpcAgentEvent",
      serverFrame: "RpcServerFrame",
      inbound: "RpcInbound",
    });
  });
});
