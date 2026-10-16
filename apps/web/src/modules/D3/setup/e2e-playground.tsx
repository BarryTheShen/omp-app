import { createAppClient } from "@omp-app/client";
import { AppPort, RpcSessionPort } from "@omp-app/contracts";
import { createRoot } from "react-dom/client";
import { APP_TOKEN_STORAGE_KEY, websocketUrl } from "../../../launch/token";
import { createProviderSetup } from "./setup";
import { ProviderSetupPanel } from "./setup-panel";

async function mount(): Promise<void> {
  const container = document.getElementById("d3-4-setup-root");
  const token = window.sessionStorage.getItem(APP_TOKEN_STORAGE_KEY);
  if (!container || !token) throw new Error("The live setup test could not connect to the app.");
  const client = createAppClient({ url: websocketUrl(window.location), token });
  window.addEventListener("pagehide", () => client.dispose(), { once: true });
  const serverInfo = await client.port(AppPort).serverInfo({});
  const opened = await client
    .port(RpcSessionPort)
    .open({ folderPath: serverInfo.launchFolder, start: "new" });
  const setup = createProviderSetup({
    client,
    threadId: opened.threadId,
    capabilities: opened.capabilities,
  });
  createRoot(container).render(<ProviderSetupPanel setup={setup} />);
}

void mount().catch((error: unknown) => {
  document.documentElement.dataset.d3SetupError =
    error instanceof Error ? error.message : "Live setup test failed.";
});
