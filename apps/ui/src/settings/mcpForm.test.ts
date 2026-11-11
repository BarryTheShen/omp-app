import { MCP_SECRET_MASK, type McpConfigServer } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import { configOf, emptyForm, formFromJson, formOf, reachWords } from "./mcpForm";

const saved: McpConfigServer = {
  name: "github",
  scope: "user",
  path: "/agent/mcp.json",
  auth: "none",
  config: {
    type: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
    env: { GITHUB_TOKEN: MCP_SECRET_MASK, EMPTY: "" },
    timeout: 30_000,
  },
};

describe("the MCP server form (#16)", () => {
  test("a saved secret left empty under its name goes back as the mask, which keeps it; a typed one replaces it", () => {
    const form = formOf(saved);
    expect(form.env).toEqual([
      { key: "GITHUB_TOKEN", value: "", savedKey: "GITHUB_TOKEN" },
      { key: "EMPTY", value: "", savedKey: null },
    ]);
    expect(configOf(form)).toEqual({
      name: "github",
      config: {
        type: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-github"],
        env: { GITHUB_TOKEN: MCP_SECRET_MASK, EMPTY: "" },
        timeout: 30_000,
      },
    });
    const typed = {
      ...form,
      env: [{ key: "GITHUB_TOKEN", value: "new", savedKey: "GITHUB_TOKEN" }],
    };
    expect(configOf(typed)).toMatchObject({ config: { env: { GITHUB_TOKEN: "new" } } });
  });

  test("a saved secret renamed and left empty, a missing command, a bad address and a bad name are refused in words", () => {
    const form = formOf(saved);
    const renamed = { ...form, env: [{ key: "GH_TOKEN", value: "", savedKey: "GITHUB_TOKEN" }] };
    expect(configOf(renamed)).toEqual({
      problem: "Type the value of GH_TOKEN again: its saved value is under GITHUB_TOKEN.",
    });
    expect(configOf({ ...form, command: " " })).toEqual({
      problem: "A local server needs the command that starts it.",
    });
    expect(configOf({ ...form, kind: "http", url: "mcp.example.com" })).toEqual({
      problem: "The server's address starts with https:// or http://.",
    });
    expect(configOf({ ...form, name: "two  spaces" })).toEqual({
      problem: "Name it with letters, digits, '.', ':', '-', '_' and single spaces.",
    });
    expect(
      configOf({ ...form, env: [...form.env, { key: "EMPTY", value: "x", savedKey: null }] }),
    ).toEqual({
      problem: "Two variables are named EMPTY.",
    });
  });

  test("arguments one a line, blank lines dropped; a remote server keeps its headers; the timeout in seconds", () => {
    const local = {
      ...emptyForm("project"),
      name: "files",
      command: "node",
      args: "server.js\n\n--root\r\n/srv\n",
      timeout: "2.5",
    };
    expect(configOf(local)).toEqual({
      name: "files",
      config: {
        type: "stdio",
        command: "node",
        args: ["server.js", "--root", "/srv"],
        timeout: 2_500,
      },
    });
    const remote = {
      ...emptyForm("user"),
      name: "docs",
      kind: "sse" as const,
      url: "https://docs.example.com/sse",
      headers: [{ key: "Authorization", value: "Bearer t", savedKey: null }],
    };
    expect(configOf(remote)).toEqual({
      name: "docs",
      config: {
        type: "sse",
        url: "https://docs.example.com/sse",
        headers: { Authorization: "Bearer t" },
      },
    });
  });

  test("JSON as MCP pages publish it fills the form: mcpServers, VS Code's servers, a named server, a server alone", () => {
    const claude = formFromJson(
      JSON.stringify({
        mcpServers: {
          github: { command: "npx", args: ["-y", "server"], env: { TOKEN: "t" } },
          other: { url: "https://x.example.com/mcp" },
        },
      }),
      "user",
    );
    expect(claude).toMatchObject({
      form: {
        name: "github",
        kind: "stdio",
        command: "npx",
        args: "-y\nserver",
        env: [{ key: "TOKEN", value: "t", savedKey: null }],
      },
      note: "This JSON has 2 servers: the form has the first, github. Add the others one at a time.",
    });
    const vscode = formFromJson(
      JSON.stringify({
        servers: { docs: { type: "sse", url: "https://d.example.com/sse", headers: { A: "b" } } },
      }),
      "project",
    );
    expect(vscode).toMatchObject({
      form: {
        name: "docs",
        scope: "project",
        kind: "sse",
        url: "https://d.example.com/sse",
        headers: [{ key: "A", value: "b" }],
      },
      note: null,
    });
    expect(
      formFromJson(JSON.stringify({ search: { url: "https://s.example.com/mcp" } }), "user"),
    ).toMatchObject({
      form: { name: "search", kind: "http" },
    });
    expect(
      formFromJson(JSON.stringify({ command: "uvx", args: ["mcp-server-time"] }), "user"),
    ).toMatchObject({
      form: { name: "", command: "uvx", args: "mcp-server-time" },
      note: null,
    });
    expect(formFromJson("{ nope", "user")).toEqual({
      problem: "This is not JSON: check its quotes, commas and brackets.",
    });
    expect(formFromJson(JSON.stringify({ theme: "dark" }), "user")).toEqual({
      problem: "No MCP server in this JSON: a server has a command or a url.",
    });
  });

  test("the list shows an address's origin alone, and masks the value of an argument that names a secret", () => {
    expect(
      reachWords({
        type: "http",
        url: "https://mcp.example.com/api/s/k3y-in-path/mcp?api_key=s3cret",
      }),
    ).toBe("https://mcp.example.com");
    expect(
      reachWords({
        type: "stdio",
        command: "npx",
        args: ["-y", "server", "--token", "t0ken", "--api-key=k3y", "--root", "/srv"],
      }),
    ).toBe(`npx -y server --token ${MCP_SECRET_MASK} --api-key=${MCP_SECRET_MASK} --root /srv`);
  });
});
