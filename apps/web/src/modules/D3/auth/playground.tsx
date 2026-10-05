import { createRoot } from "react-dom/client";
import "../../../index.css";
import type { CapabilityMap } from "@omp-app/contracts";
import type { AuthPort } from "../contract";
import { AUTH_CAPABILITIES } from "../contract";
import { ProviderLoginPanel } from "./login";

const capabilities: CapabilityMap = {
  [AUTH_CAPABILITIES.getLoginProviders]: { state: "available", via: "rpc" },
  [AUTH_CAPABILITIES.login]: { state: "available", via: "rpc" },
};

const auth: AuthPort = {
  capabilities: () => capabilities,
  getLoginProviders: async () => [
    { id: "provider-a", name: "Provider A", available: true, authenticated: false },
    { id: "provider-b", name: "Provider B", available: false, authenticated: false },
    { id: "provider-c", name: "Provider C", available: true, authenticated: true },
  ],
  login: async (providerId) => {
    await new Promise((resolve) => setTimeout(resolve, 350));
    return { state: "authenticated", providerId };
  },
};

const root = document.getElementById("d3-login-playground-root");
if (!root) throw new Error("D3 login playground root is missing.");
createRoot(root).render(
  <main className="bg-background text-foreground flex min-h-screen items-start justify-center px-4 py-8 sm:px-8">
    <ProviderLoginPanel auth={auth} />
  </main>,
);
