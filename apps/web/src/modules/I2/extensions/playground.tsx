import { FolderPath } from "@omp-app/contracts";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Button } from "@/components/ui/button";
import type { ExtensionCatalog, ExtensionCatalogSnapshot } from "../catalog";
import { ExtensionControlCenter } from "./control-center";

const folder = FolderPath.parse("/workspace/project");
const snapshot: ExtensionCatalogSnapshot = {
  revision: "revision-playground",
  extensions: [
    {
      id: "plugin-one",
      name: "Release helper",
      provider: "demo-plugin",
      source: "plugin",
      version: "1.4.0",
      enabled: true,
      shadowed: false,
      capabilities: ["tools", "commands"],
      description: "Metadata from an untrusted extension source is displayed as text.",
    },
    {
      id: "extension-two",
      name: "Review assistant",
      provider: "demo-extension",
      source: "extension",
      version: "0.9.0",
      enabled: false,
      shadowed: true,
      capabilities: ["review"],
      description: "Disabled and shadowed metadata stays visible for inspection.",
    },
  ],
  skills: [
    {
      id: "skill-one",
      name: "Project skill",
      provider: "demo-skill",
      source: "skill",
      enabled: true,
      shadowed: false,
      capabilities: [],
      description: "A registered skill.",
    },
  ],
  prompts: [
    { name: "review-plan", provider: "demo-extension", source: "extension", enabled: true },
  ],
  sources: [
    { source: "plugin", provider: "demo-plugin", total: 1, enabled: 1, shadowed: 0 },
    { source: "extension", provider: "demo-extension", total: 1, enabled: 0, shadowed: 1 },
    { source: "skill", provider: "demo-skill", total: 1, enabled: 1, shadowed: 0 },
  ],
  truncated: false,
};

function createCatalog(): ExtensionCatalog {
  return {
    list: async () => snapshot,
    reload: async () => ({ ...snapshot, revision: "revision-reloaded" }),
    subscribe: async () => async () => undefined,
  };
}

function Playground() {
  const [theme, setTheme] = useState<"light" | "dark">(() =>
    document.documentElement?.classList.contains("dark") ? "dark" : "light",
  );
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    const root = document.documentElement;
    if (!root) return;
    root.classList.toggle("dark", theme === "dark");
    return () => root.classList.remove("dark");
  }, [theme]);
  return (
    <main
      className="min-h-screen bg-background text-foreground"
      data-testid="i2-extension-playground"
    >
      <header className="border-border flex min-h-14 items-center justify-between gap-3 border-b px-4 py-3">
        <div>
          <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">I2.2</p>
          <h1 className="text-sm font-semibold">Extension Control Center</h1>
        </div>
        <div className="flex gap-2">
          <Button
            data-testid="theme-light"
            size="sm"
            type="button"
            variant="outline"
            onClick={() => setTheme("light")}
          >
            Light
          </Button>
          <Button
            data-testid="theme-dark"
            size="sm"
            type="button"
            variant="outline"
            onClick={() => setTheme("dark")}
          >
            Dark
          </Button>
          <Button
            data-testid="catalog-unavailable"
            size="sm"
            type="button"
            variant="outline"
            onClick={() => setUnavailable(true)}
          >
            Offline
          </Button>
        </div>
      </header>
      <ExtensionControlCenter
        catalog={createCatalog()}
        folder={folder}
        capabilities={
          unavailable ? {} : { "host.extension-catalog": { state: "available", via: "host" } }
        }
      />
    </main>
  );
}

const root = document.getElementById("i2-extension-playground-root");
if (!root) throw new Error("I2.2 extension playground root is missing.");
createRoot(root).render(<Playground />);
