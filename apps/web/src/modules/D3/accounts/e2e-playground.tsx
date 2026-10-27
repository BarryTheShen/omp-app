import { AppPort, RpcSessionPort } from "@omp-app/contracts";
import { createRoot } from "react-dom/client";
import { createChatSessionAppClient } from "../../../launch/chat-session-shim";
import { APP_TOKEN_STORAGE_KEY, websocketUrl } from "../../../launch/token";
import type { ConfirmDialogRequest, DialogHost, DialogHostOpenOptions } from "../../U4/contract";
import { createProviderAccounts } from "./accounts";
import { ProviderAccountsPanel } from "./accounts-panel";

async function mount(): Promise<void> {
  const container = document.getElementById("d3-3-accounts-root");
  const token = window.sessionStorage.getItem(APP_TOKEN_STORAGE_KEY);
  if (!container || !token) throw new Error("The live account test could not connect to the app.");
  const client = createChatSessionAppClient({ url: websocketUrl(window.location), token });
  window.addEventListener("pagehide", () => client.dispose(), { once: true });
  const serverInfo = await client.port(AppPort).serverInfo({});
  const opened = await client
    .port(RpcSessionPort)
    .open({ folderPath: serverInfo.launchFolder, start: "new" });
  const dialogs = {
    confirm: async (request: ConfirmDialogRequest, _options: DialogHostOpenOptions) =>
      window.confirm(request.message),
  } satisfies Pick<DialogHost, "confirm">;
  const accounts = createProviderAccounts({
    client,
    threadId: opened.threadId,
    providerId: "provider-a",
    capabilities: opened.capabilities,
    dialogs,
  });
  createRoot(container).render(
    <ProviderAccountsPanel
      accounts={accounts}
      available={opened.capabilities["host.provider-accounts"]?.state === "available"}
    />,
  );
}

void mount().catch((error: unknown) => {
  document.documentElement.dataset.d3AccountsError =
    error instanceof Error ? error.message : "Live account test failed.";
});
