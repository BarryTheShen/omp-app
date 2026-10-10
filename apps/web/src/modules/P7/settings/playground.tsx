import type { AppClient } from "@omp-app/client";
import { FolderPath } from "@omp-app/contracts";
import { useAppConnection } from "@/launch/app-connection";
import { ContextSettings, type ContextSettingsScope } from "./index";

export function ContextSettingsPlayground() {
  const connection = useAppConnection();
  const client = connection.client;
  if (!client) {
    const waiting = connection.state === "connecting" || connection.state === "reconnecting";
    return (
      <main className="bg-background text-foreground flex min-h-dvh items-center justify-center p-6">
        <p className="text-muted-foreground text-sm" role={waiting ? "status" : "alert"}>
          {connection.reason ?? "Connecting to omp-app…"}
        </p>
      </main>
    );
  }

  const parameters = new URLSearchParams(window.location.search);
  const embedded = parameters.get("embedded") === "1";
  if (parameters.get("layer") !== "project") {
    return <PlaygroundView client={client} embedded={embedded} scope={{ layer: "global" }} />;
  }
  const folder = parameters.get("folder");
  if (folder === null) {
    return (
      <main className="bg-background text-foreground flex min-h-dvh items-center justify-center p-6">
        <p className="text-destructive text-sm" role="alert">
          Choose a project folder to preview project settings.
        </p>
      </main>
    );
  }
  return (
    <PlaygroundView
      client={client}
      embedded={embedded}
      scope={{ layer: "project", folder: FolderPath.parse(folder) }}
    />
  );
}

/** Embedded mode mounts the view the way the live Settings screen does: no header, inside a plain panel. */
function PlaygroundView({
  client,
  embedded,
  scope,
}: {
  readonly client: AppClient;
  readonly embedded: boolean;
  readonly scope: ContextSettingsScope;
}) {
  if (!embedded) return <ContextSettings client={client} scope={scope} />;
  return (
    <div className="bg-background text-foreground mx-auto my-6 w-120 max-w-full rounded-lg border p-4">
      <ContextSettings client={client} scope={scope} showHeader={false} />
    </div>
  );
}
