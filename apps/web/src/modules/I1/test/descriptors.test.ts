import type { AppClient } from "@omp-app/client";
import {
  AppFailure,
  INVENTORY,
  type McpCommandsPort,
  type PortClient,
  ThreadId,
  validateRegistry,
} from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import { DESCRIPTORS } from "@/registry";
import {
  I1_DESCRIPTORS,
  I1_MCP_AUTH_DESCRIPTORS,
  I1_MCP_PROTOCOL_DESCRIPTORS,
  I1_SETTINGS_DESCRIPTOR,
} from "../descriptors";
import { createMcpServerPort } from "../servers";
import { I1_MCP_SERVER_DESCRIPTORS } from "../servers/descriptors";
import { MCP_SETTING_KEYS, MCP_SETTINGS_SECTION_DESCRIPTOR } from "../settings";

const I1_INVENTORY_QUERY = (id: string): boolean =>
  id.startsWith("C4.mcp") || id === "C4.auth-gateway-stdio" || id === "S5.tools-discovery-mcp";

const INTENDED_DUPLICATE_TITLES: Readonly<Record<string, readonly string[]>> = {
  "Add MCP server": ["I1.mcpAdd", "I1.mcpAddWizard"],
};

describe("I1 descriptors and inventory gate", () => {
  test("claims the computed C4.mcp/auth and S5 settings rows once", () => {
    const query =
      "inventory.id.startsWith('C4.mcp') || inventory.id === 'C4.auth-gateway-stdio' || inventory.id === 'S5.tools-discovery-mcp'";
    const expected = INVENTORY.filter((item) => I1_INVENTORY_QUERY(item.id))
      .map((item) => item.id)
      .sort();
    expect(expected).toHaveLength(21);
    expect(query).toContain("C4.mcp");
    const available = INVENTORY.map((item) => item.id);
    expect(expected.every((id) => available.includes(id))).toBe(true);
    const covered = I1_DESCRIPTORS.flatMap((descriptor) => descriptor.covers);
    expect([...covered].sort()).toEqual(expected);
    expect(new Set(covered).size).toBe(covered.length);
    const ids = I1_DESCRIPTORS.map((descriptor) => descriptor.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("validates its descriptors and the registry composition without duplicating the existing I1 server spread", () => {
    expect(validateRegistry(I1_DESCRIPTORS)).toEqual([]);
    expect(validateRegistry(DESCRIPTORS)).toEqual([]);
    const registeredI1 = DESCRIPTORS.filter((descriptor) => descriptor.owner === "I1");
    expect(registeredI1).toEqual(I1_MCP_SERVER_DESCRIPTORS);

    const otherModules = DESCRIPTORS.filter((descriptor) => descriptor.owner !== "I1");
    expect(validateRegistry([...otherModules, ...I1_DESCRIPTORS])).toEqual([]);
    expect(I1_DESCRIPTORS.every((descriptor) => descriptor.owner === "I1")).toBe(true);
    expect(I1_DESCRIPTORS.every((descriptor) => descriptor.id.startsWith("I1."))).toBe(true);
  });

  test("uses exact readable titles and gates terminal-only and auth commands honestly", () => {
    const titles = I1_DESCRIPTORS.map((descriptor) => descriptor.title);
    const duplicateTitles = Object.fromEntries(
      Object.entries(
        titles.reduce<Record<string, string[]>>((groups, title, index) => {
          const id = I1_DESCRIPTORS[index]?.id;
          if (id !== undefined) {
            const ids = groups[title] ?? [];
            ids.push(id);
            groups[title] = ids;
          }
          return groups;
        }, {}),
      ).filter(([, ids]) => ids.length > 1),
    );
    expect(duplicateTitles).toEqual(INTENDED_DUPLICATE_TITLES);
    for (const title of titles) {
      expect(title).not.toMatch(/C4|RPC|capability|upstream|descriptor/i);
    }

    const gateway = I1_DESCRIPTORS.find((descriptor) => descriptor.id === "I1.authGatewayStdio");
    expect(gateway).toMatchObject({
      title: "Provider credential gateway for terminal clients",
      requires: ["upstream.auth-gateway-stdio"],
    });
    expect(gateway).not.toHaveProperty("slash");

    const authRequirements = Object.fromEntries(
      I1_MCP_AUTH_DESCRIPTORS.map((descriptor) => [descriptor.id, descriptor.requires]),
    );
    expect(authRequirements["I1.mcpSmitheryLogin"]).toContain("upstream.mcp-auth");
    expect(authRequirements["I1.mcpSmitheryLogout"]).toContain("upstream.mcp-auth");
    expect(authRequirements["I1.mcpSmitheryLogin"]).not.toContain("upstream.smithery");
    const smitherySearch = I1_MCP_PROTOCOL_DESCRIPTORS.find(
      (descriptor) => descriptor.id === "I1.mcpSmitherySearch",
    );
    expect(smitherySearch?.requires).toEqual(["host.command-gateway", "host.mcp"]);
  });

  test("derives the C0 settings descriptor from the real MCP section and setting key", () => {
    const representative = MCP_SETTINGS_SECTION_DESCRIPTOR.controls[0];
    if (representative === undefined) throw new Error("the MCP settings section has no controls");
    expect(MCP_SETTING_KEYS).toContain(representative.key);
    expect(I1_SETTINGS_DESCRIPTOR).toEqual({
      id: MCP_SETTINGS_SECTION_DESCRIPTOR.id,
      owner: "I1",
      title: MCP_SETTINGS_SECTION_DESCRIPTOR.title,
      kind: "setting",
      covers: [...MCP_SETTINGS_SECTION_DESCRIPTOR.inventory],
      requires: [...MCP_SETTINGS_SECTION_DESCRIPTOR.requires],
      key: representative.key,
      section: MCP_SETTINGS_SECTION_DESCRIPTOR.section,
    });
  });
});

const safeMcpServer = {
  name: "private-server",
  scope: "user",
  transport: "http",
  enabled: true,
  status: "ready",
  command: "mcp-server",
  url: "https://mcp.example.test",
  auth: "none",
  source: {
    origin: "user",
    path: "/workspace/.omp/mcp.json",
    reloadRequired: true,
  },
} as const;

async function listFailure(server: Record<string, unknown>): Promise<AppFailure> {
  const commands = {
    servers: async () => ({ servers: [server], revision: "mcp-revision-1" }),
  } as unknown as PortClient<typeof McpCommandsPort>;
  const client = { port: () => commands } as unknown as AppClient;
  const serverPort = createMcpServerPort(client, ThreadId.parse("thread-i1-descriptor-gate"));
  try {
    await serverPort.list();
  } catch (error) {
    if (error instanceof AppFailure) return error;
    throw error;
  }
  throw new Error("the unsafe MCP result was accepted");
}

describe("I1 MCP security gate", () => {
  test("rejects URL credentials and query data at the MCP port boundary", async () => {
    const secret = ["private", "mcp", "fixture"].join("-");
    const failure = await listFailure({
      ...safeMcpServer,
      url: `https://user:${secret}@mcp.example.test/mcp?token=${secret}`,
    });
    expect(failure.message).toBe("The MCP server list cannot be displayed safely.");
    expect(failure.message).not.toContain(secret);
  });

  test("rejects unknown secret-bearing result keys at the MCP port boundary", async () => {
    const secret = ["private", "mcp", "fixture"].join("-");
    const failure = await listFailure({
      ...safeMcpServer,
      env: { API_KEY: secret },
    });
    expect(failure.message).toBe("The MCP server list cannot be displayed safely.");
    expect(failure.message).not.toContain(secret);
  });
});
