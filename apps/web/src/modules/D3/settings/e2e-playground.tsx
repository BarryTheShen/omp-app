import { type AppClient, createAppClient } from "@omp-app/client";
import { AppFailure, AppPort, ChatSessionPort, type ConfigWriteArgs } from "@omp-app/contracts";
import { createRoot } from "react-dom/client";
import { APP_TOKEN_STORAGE_KEY, websocketUrl } from "../../../launch/token";
import { createProviderSettingsController } from "./controller";
import { ProviderSettingsPanel } from "./settings-panel";

function previewClient(state: "error" | "save" | "conflict"): AppClient {
  let value = "standard";
  const list = async () => {
    if (state === "error") {
      throw new AppFailure({
        code: "permission",
        message: "The provider settings could not be read here.",
        retryable: true,
      });
    }
    return {
      revision: state === "conflict" ? "preview-revision-2" : "preview-revision-1",
      entries: [
        { key: "providers.fireworksTier", secret: false, value, source: "global", overrides: [] },
      ],
    };
  };
  const write = async (args: ConfigWriteArgs) => {
    if (state === "save") {
      throw new AppFailure({
        code: "permission",
        message: "The provider settings could not be saved here.",
        retryable: true,
      });
    }
    if (state === "conflict") {
      value = "off";
      throw new AppFailure({
        code: "conflict",
        message: "Another writer changed this setting.",
        retryable: true,
      });
    }
    value = String(args.value.secret ? "standard" : args.value.value);
    return {
      key: args.key,
      layer: "global" as const,
      folder: null,
      revision: "preview-revision-2",
      entry: { key: args.key, secret: false, value, source: "global" as const, overrides: [] },
    };
  };
  return {
    port: () => ({
      list,
      read: async () => {
        throw new Error("unused");
      },
      write,
    }),
    subscribe: async () => ({ unsubscribe: async () => undefined }),
  } as unknown as AppClient;
}

async function mount(): Promise<void> {
  const container = document.getElementById("d3-5-settings-root");
  const token = window.sessionStorage.getItem(APP_TOKEN_STORAGE_KEY);
  if (!container || !token)
    throw new Error("The live provider settings test could not connect to the app.");
  const preview = new URLSearchParams(window.location.search).get("state") as
    | "error"
    | "save"
    | "conflict"
    | null;
  if (preview) {
    const controller = createProviderSettingsController({
      client: previewClient(preview),
      capabilities: { "host.config": { state: "available", via: "host" } },
      folder: null,
    });
    const runtime = controller.runtime(controller.selectedSectionId());
    await runtime.read().catch(() => undefined);
    if (preview !== "error")
      runtime.stage("providers.fireworksTier", { secret: false, value: "priority" });
    createRoot(container).render(<ProviderSettingsPanel controller={controller} />);
    return;
  }
  const client = createAppClient({ url: websocketUrl(window.location), token });
  window.addEventListener("pagehide", () => client.dispose(), { once: true });
  const serverInfo = await client.port(AppPort).serverInfo({});
  await client.port(ChatSessionPort).open({ folderPath: serverInfo.launchFolder, start: "new" });
  const capabilities = await client.port(AppPort).capabilities({});
  const controller = createProviderSettingsController({
    client,
    capabilities,
    folder: serverInfo.launchFolder,
  });
  await controller.runtime(controller.selectedSectionId()).read();
  createRoot(container).render(<ProviderSettingsPanel controller={controller} />);
}

void mount().catch((error: unknown) => {
  document.documentElement.dataset.d3SettingsError =
    error instanceof Error ? error.message : "Live provider settings test failed.";
});
