import { AppFailure, CapabilityKey, McpCommandRemoteUrl } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import {
  HostToolDefinition,
  HostToolName,
  HostUriScheme,
  I1_CAPABILITIES,
  McpPromptInvokeArgs,
  McpServerConfig,
  McpServerName,
  McpServerSummary,
  McpSettingsSection,
  McpUrlOrigin,
  redactMcpServerConfig,
  toI1Failure,
} from ".";

describe("I1 browser contracts", () => {
  test("publishes the host and client capability gates", () => {
    expect(I1_CAPABILITIES).toEqual({
      mcp: "host.mcp",
      mcpReconnect: "upstream.mcp-reconnect",
      mcpSettings: "client.mcp-settings",
      hostTools: "omp.host-tools",
      hostUris: "omp.host-uris",
    });
    for (const capability of Object.values(I1_CAPABILITIES)) {
      expect(CapabilityKey.safeParse(capability).success).toBe(true);
    }
  });

  test("allows safe HTTP(S) server paths but rejects URL credentials, queries and fragments", () => {
    expect(McpCommandRemoteUrl.safeParse("https://mcp.example.test/api/v1").success).toBe(true);
    for (const value of [
      "https://user:password@mcp.example.test/api/v1",
      "https://mcp.example.test/api/v1?token=secret",
      "https://mcp.example.test/api/v1#token",
    ]) {
      expect(McpCommandRemoteUrl.safeParse(value).success).toBe(false);
    }
  });

  test("redacts MCP config values while preserving safe names and URL origins", () => {
    const redacted = redactMcpServerConfig({
      name: "filesystem",
      scope: "user",
      transport: "http",
      enabled: true,
      status: "ready",
      command: "node /tmp/server.js --token secret-value",
      url: "https://mcp.example.test/api?access_token=secret-value",
      auth: "oauth",
      source: {
        origin: "user",
        path: "/home/user/.omp/agent/mcp.json",
        safePath: false,
        reloadRequired: true,
      },
      args: ["--token", "secret-value"],
      env: { API_TOKEN: "secret-value" },
      headers: { Authorization: "Bearer secret-value" },
    });
    expect(redacted).toEqual({
      name: "filesystem",
      scope: "user",
      transport: "http",
      enabled: true,
      status: "ready",
      command: "node",
      url: "https://mcp.example.test",
      auth: "oauth",
      source: { origin: "user", reloadRequired: true },
      envKeys: ["API_TOKEN"],
      headers: ["Authorization"],
    });
    expect(JSON.stringify(redacted)).not.toContain("secret-value");
    expect(JSON.stringify(redacted)).not.toContain("/home/user");
  });

  test("accepts explicitly safe DTOs and rejects URL path/query leakage", () => {
    expect(
      McpServerSummary.safeParse({
        name: "safe-server",
        scope: "project",
        transport: "stdio",
        enabled: false,
        status: "configured",
        command: "mcp-server",
        auth: "none",
        source: { origin: "project", path: "/workspace/.omp/mcp.json", reloadRequired: false },
      }).success,
    ).toBe(true);
    expect(McpUrlOrigin.safeParse("https://mcp.example.test").success).toBe(true);
    expect(McpUrlOrigin.safeParse("https://mcp.example.test/api?token=secret").success).toBe(false);
    expect(
      McpServerConfig.safeParse({
        name: "unsafe",
        scope: "user",
        transport: "stdio",
        enabled: true,
        status: "ready",
        auth: "none",
        source: { origin: "user", reloadRequired: false },
        env: { TOKEN: "secret" },
      }).success,
    ).toBe(false);
  });

  test("validates host names, schemes and prompt argument shapes", () => {
    expect(HostToolName.safeParse("mcp.filesystem").success).toBe(true);
    for (const name of ["cloudflare:cloudflare-api", "_internal", ".hidden", "-dash"]) {
      expect(McpServerName.safeParse(name).success).toBe(true);
    }
    expect(McpServerName.safeParse("MaaS Slack").success).toBe(false);
    expect(
      HostToolDefinition.safeParse({ name: "mcp.no-description", inputSchema: {} }).success,
    ).toBe(false);
    expect(
      HostToolDefinition.safeParse({
        name: "mcp.blank-description",
        description: " ",
        inputSchema: {},
      }).success,
    ).toBe(false);
    expect(HostToolName.safeParse("mcp filesystem").success).toBe(false);
    expect(HostUriScheme.safeParse("mcp+resource").success).toBe(true);
    expect(HostUriScheme.safeParse("MCP").success).toBe(false);
    expect(
      McpSettingsSection.parse({ section: "tools/Discovery & MCP", keys: ["mcp.enabled"] }),
    ).toEqual({
      section: "tools/Discovery & MCP",
      keys: ["mcp.enabled"],
    });
    expect(McpPromptInvokeArgs.parse({ id: "prompt-1" })).toEqual({
      id: "prompt-1",
      arguments: {},
    });
  });

  test("preserves typed failures and hides unknown error details", () => {
    const typed = new AppFailure({ code: "permission", message: "denied", retryable: false });
    expect(toI1Failure(typed, "fallback")).toBe(typed);
    const mapped = toI1Failure(new Error("secret-token"), "MCP operation failed");
    expect(mapped.appError).toEqual({
      code: "internal",
      message: "MCP operation failed",
      retryable: false,
    });
    expect(mapped.appError.message).not.toContain("secret-token");
  });
});
