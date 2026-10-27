import {
  AppFailure,
  AppPort,
  type RpcSessionClient,
  RpcSessionPort,
  type ThreadId,
} from "@omp-app/contracts";
import { createChatSessionAppClient } from "../../../launch/chat-session-shim";
import { APP_TOKEN_STORAGE_KEY, websocketUrl } from "../../../launch/token";
import { createMcpProtocolAdapter, type McpProtocolAdapter } from "./index";

const root = document.documentElement;
const MCP_SERVER_NAME = "cloudflare:cloudflare-api";
const ADDED_SERVER_NAME = "maas-slack";
const MCP_CONFIG_CHECK_KEY = "omp-app-i1-mcp-config-checked";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The MCP integration failed.";
}

async function runMcpIntegration(): Promise<void> {
  root.dataset.i1McpTestStatus = "running";
  delete root.dataset.i1McpTestError;
  delete root.dataset.i1McpTestStage;
  window.sessionStorage.removeItem(MCP_CONFIG_CHECK_KEY);
  const fakeMcpServerPath = new URL(window.location.href).searchParams.get("mcpServer");
  if (fakeMcpServerPath === null) throw new Error("The test MCP server path was not provided.");
  const addedArguments = [
    "run",
    fakeMcpServerPath,
    "hello world",
    "it's",
    "$shell",
    "`tick`",
    'say "hi"',
  ];
  const token = window.sessionStorage.getItem(APP_TOKEN_STORAGE_KEY);
  if (token === null) throw new Error("The app session token was not available.");

  const client = createChatSessionAppClient({ url: websocketUrl(window.location), token });
  let rpc: RpcSessionClient | undefined;
  let threadId: ThreadId | undefined;
  let protocol: McpProtocolAdapter | undefined;
  let secondProtocol: McpProtocolAdapter | undefined;
  let typedToolOneRegistered = false;
  let typedToolTwoRegistered = false;
  let typedSchemeOneRegistered = false;
  let typedSchemeTwoRegistered = false;
  let cleanupFailed = false;
  const rawToolOwnerOne = crypto.randomUUID();
  const rawToolOwnerTwo = crypto.randomUUID();
  const failures: string[] = [];
  try {
    const serverInfo = await client.port(AppPort).serverInfo({});
    rpc = client.port(RpcSessionPort);
    const opened = await rpc.open({
      folderPath: serverInfo.launchFolder,
      start: "new",
    });
    threadId = opened.threadId;
    if (opened.capabilities["host.mcp"]?.state !== "available") {
      throw new Error("The MCP server capability was not published.");
    }
    protocol = createMcpProtocolAdapter({
      client,
      threadId,
      capabilities: opened.capabilities,
    });
    secondProtocol = createMcpProtocolAdapter({
      client,
      threadId,
      capabilities: opened.capabilities,
    });

    const serverList = await protocol.servers.list();
    const initialServer = serverList.servers.find((server) => server.name === MCP_SERVER_NAME);
    if (
      serverList.servers.length !== 1 ||
      initialServer?.transport !== "stdio" ||
      initialServer.command !== "bun"
    ) {
      throw new Error("The harness MCP server was not listed with its local command.");
    }
    const prompts = await protocol.prompts.list();
    const docstringPrompt = prompts.find((prompt) => prompt.name === "docstring");
    const resources = await protocol.resources.list();
    const privateResources = resources.filter((resource) => resource.name.endsWith(".md"));
    if (
      prompts.length !== 3 ||
      docstringPrompt?.description !==
        "First line of a docstring.\n\nArgs:\n    topic: what to explain" ||
      resources.length !== 3 ||
      privateResources.length !== 2 ||
      privateResources[0]?.id === privateResources[1]?.id ||
      privateResources.some((resource) => !resource.uri.startsWith("file://<private-path>/"))
    ) {
      throw new Error("The live MCP prompt and resource catalogs were incomplete or unsafe.");
    }
    const remoteResource = resources.find((resource) => resource.name === "data");
    if (remoteResource?.uri !== "https://api.example.test/data") {
      throw new Error("The live MCP resource address retained query credentials.");
    }
    const serverTest = await protocol.servers.test({
      name: MCP_SERVER_NAME,
      scope: "user",
      operationId: "e2e-mcp-test",
    });
    if (serverTest.message !== "Connected to the MCP server. Found 1 tool.") {
      throw new Error("The live MCP server test result was not parsed correctly.");
    }

    const firstTypedTool = await protocol.hostTools.setTools([
      {
        name: "e2e_adapter_one",
        description: "A temporary first adapter tool.",
        inputSchema: { type: "object", properties: {} },
      },
    ]);
    typedToolOneRegistered = true;
    const secondTypedTool = await secondProtocol.hostTools.setTools([
      {
        name: "e2e_adapter_two",
        description: "A temporary second adapter tool.",
        inputSchema: { type: "object", properties: {} },
      },
    ]);
    typedToolTwoRegistered = true;
    if (
      !firstTypedTool.names.includes("e2e_adapter_one") ||
      !secondTypedTool.names.includes("e2e_adapter_two")
    ) {
      throw new Error("The typed host tool registrations were not accepted.");
    }
    await protocol.hostTools.unregister("e2e_adapter_one");
    typedToolOneRegistered = false;
    await secondProtocol.hostTools.unregister("e2e_adapter_two");
    typedToolTwoRegistered = false;

    const firstTypedScheme = await protocol.hostUris.setSchemes([
      { scheme: "e2eone", operations: ["read"], description: "First temporary address." },
    ]);
    typedSchemeOneRegistered = true;
    const secondTypedScheme = await secondProtocol.hostUris.setSchemes([
      { scheme: "e2etwo", operations: ["read"], description: "Second temporary address." },
    ]);
    typedSchemeTwoRegistered = true;
    if (
      !firstTypedScheme.schemes.includes("e2eone") ||
      !secondTypedScheme.schemes.includes("e2etwo")
    ) {
      throw new Error("The typed host address registrations were not accepted.");
    }
    await protocol.hostUris.unregister("e2eone");
    typedSchemeOneRegistered = false;
    await secondProtocol.hostUris.unregister("e2etwo");
    typedSchemeTwoRegistered = false;

    const rawToolOne = {
      name: "e2e_raw_one",
      label: "First temporary raw tool",
      description: "A process-owned test tool.",
      parameters: { type: "object" },
      loadMode: "essential" as const,
    };
    const rawToolTwo = {
      name: "e2e_raw_two",
      label: "Second temporary raw tool",
      description: "A process-owned test tool.",
      parameters: { type: "object" },
      loadMode: "essential" as const,
    };
    await rpc.send({
      threadId,
      registrationOwner: rawToolOwnerOne,
      command: { type: "set_host_tools", tools: [rawToolOne] },
    });
    await rpc.send({
      threadId,
      registrationOwner: rawToolOwnerTwo,
      command: { type: "set_host_tools", tools: [rawToolTwo] },
    });
    const bothToolNames = (await rpc.send({ threadId, command: { type: "get_state" } })).dumpTools
      ?.map((tool) => tool.name)
      .filter((name) => name.startsWith("e2e_raw_"));
    if (!bothToolNames?.includes("e2e_raw_one") || !bothToolNames.includes("e2e_raw_two")) {
      throw new Error("A second host registration replaced the first one in omp.");
    }
    await rpc.send({
      threadId,
      registrationOwner: rawToolOwnerOne,
      command: { type: "set_host_tools", tools: [] },
    });
    const remainingToolNames = (
      await rpc.send({ threadId, command: { type: "get_state" } })
    ).dumpTools
      ?.map((tool) => tool.name)
      .filter((name) => name.startsWith("e2e_raw_"));
    if (
      remainingToolNames?.includes("e2e_raw_one") ||
      !remainingToolNames?.includes("e2e_raw_two")
    ) {
      throw new Error("Removing one host owner removed another owner's tool.");
    }
    await rpc.send({
      threadId,
      registrationOwner: rawToolOwnerTwo,
      command: { type: "set_host_tools", tools: [] },
    });

    const missingDescription = await rpc
      .send({
        threadId,
        registrationOwner: crypto.randomUUID(),
        command: {
          type: "set_host_tools",
          tools: [
            {
              name: "e2e_missing_description",
              label: "Missing description",
              description: "",
              parameters: { type: "object" },
            },
          ],
        },
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    if (
      !(missingDescription instanceof AppFailure) ||
      missingDescription.appError.code !== "omp_error" ||
      !missingDescription.appError.message.includes("non-empty description")
    ) {
      throw new Error("omp did not reject a host tool without a usable description.");
    }

    const added = await protocol.servers.add({
      name: ADDED_SERVER_NAME,
      scope: "user",
      operationId: "e2e-mcp-add",
      command: "bun",
      args: addedArguments,
    });
    root.dataset.i1McpTestStage = "added";
    await new Promise<void>((resolve) => {
      const waitForConfigCheck = (): void => {
        if (window.sessionStorage.getItem(MCP_CONFIG_CHECK_KEY) === "continue") resolve();
        else window.setTimeout(waitForConfigCheck, 50);
      };
      waitForConfigCheck();
    });
    const updatedList = await protocol.servers.list();
    const addedServer = updatedList.servers.find((server) => server.name === ADDED_SERVER_NAME);
    if (added.server?.command !== "bun" || addedServer?.command !== "bun") {
      throw new Error("The added MCP server was not listed with its executable name.");
    }
    const removed = await protocol.servers.remove({
      name: ADDED_SERVER_NAME,
      scope: "user",
      operationId: "e2e-mcp-remove",
      confirmed: true,
    });
    const removedList = await protocol.servers.list();
    if (removed.status !== "disabled" || removedList.servers.length !== 1) {
      throw new Error("The added MCP server could not be removed from the test configuration.");
    }

    root.dataset.i1McpTestResult = JSON.stringify({
      hostMcp: opened.capabilities["host.mcp"]?.state,
      serverCount: serverList.servers.length,
      serverName: initialServer.name,
      serverCommand: initialServer.command,
      promptCount: prompts.length,
      multilineDescription: docstringPrompt.description,
      resourceCount: resources.length,
      privateResourceUris: privateResources.map((resource) => resource.uri),
      privateResourceIdsDistinct: privateResources[0]?.id !== privateResources[1]?.id,
      remoteResourceUri: remoteResource.uri,
      notificationState: protocol.notifications.state,
      serverTestMessage: serverTest.message,
      typedToolsRegistered: true,
      typedSchemesRegistered: true,
      rawRegistryMerged: true,
      missingDescriptionRejected: true,
      addedServerName: added.server?.name,
      updatedServerCount: updatedList.servers.length,
      removedServerCount: removedList.servers.length,
      removedServerStatus: removed.status,
    });
  } catch (error) {
    failures.push(errorMessage(error));
  } finally {
    try {
      if (rpc !== undefined && threadId !== undefined) {
        await rpc.send({
          threadId,
          registrationOwner: rawToolOwnerOne,
          command: { type: "set_host_tools", tools: [] },
        });
        await rpc.send({
          threadId,
          registrationOwner: rawToolOwnerTwo,
          command: { type: "set_host_tools", tools: [] },
        });
      }
    } catch {
      cleanupFailed = true;
    }
    try {
      if (typedSchemeTwoRegistered && secondProtocol)
        await secondProtocol.hostUris.unregister("e2etwo");
    } catch {
      cleanupFailed = true;
    }
    try {
      if (typedSchemeOneRegistered && protocol) await protocol.hostUris.unregister("e2eone");
    } catch {
      cleanupFailed = true;
    }
    try {
      if (typedToolTwoRegistered && secondProtocol)
        await secondProtocol.hostTools.unregister("e2e_adapter_two");
    } catch {
      cleanupFailed = true;
    }
    try {
      if (typedToolOneRegistered && protocol)
        await protocol.hostTools.unregister("e2e_adapter_one");
    } catch {
      cleanupFailed = true;
    }
    secondProtocol?.dispose();
    protocol?.dispose();
    client.dispose();
  }
  if (cleanupFailed) failures.push("Host registrations could not be removed.");
  if (failures.length > 0) throw new Error(failures.join(" "));
}

void runMcpIntegration().then(
  () => {
    root.dataset.i1McpTestStatus = "complete";
  },
  (error: unknown) => {
    const message = errorMessage(error);
    root.dataset.i1McpTestError = message;
    console.error("MCP integration test failed:", message);
    root.dataset.i1McpTestStatus = "failed";
  },
);
