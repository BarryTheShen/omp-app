import type { AppClient, ConnectionStateEvent } from "@omp-app/client";
import type { FolderPath } from "@omp-app/contracts";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { AppConnectionGate, AppConnectionProvider, useAppConnection } from "@/launch";
import { OverlayHost } from "@/overlay";
import { FOLDER_KEY, rememberLaunchFolder } from "./session-storage";
import { useAppChatState } from "./use-app-chat-state";

const SERVER_FOLDER = "/server/home" as FolderPath;

const client = {
  connectionState: "open",
  instanceId: "test-instance",
  onConnectionState(listener: (event: ConnectionStateEvent) => void) {
    listener({ state: "open", attempt: 0 });
    return () => undefined;
  },
  onResync: () => () => undefined,
  port: () => ({}),
  dispose: () => undefined,
} as unknown as AppClient;

function OpenedPage({ opened }: { readonly opened: AppClient }) {
  const { folder } = useAppChatState({ client: opened, launchFolder: SERVER_FOLDER });
  return <output data-testid="folder">{folder}</output>;
}

function Page() {
  const { client: opened } = useAppConnection();
  return opened === null ? null : <OpenedPage opened={opened} />;
}

/** The folder the app opens on when the page loads with this address fragment, as `AppRoot` wires it. */
async function openedFolder(hash: string): Promise<string | null> {
  render(
    <AppConnectionProvider
      createClient={() => client}
      history={{ replaceState: () => undefined }}
      location={{
        hash,
        pathname: "/",
        search: "",
        protocol: "http:",
        host: "127.0.0.1:4317",
      }}
      onLaunchFolder={rememberLaunchFolder}
      storage={{ getItem: () => null, setItem: () => undefined }}
    >
      <AppConnectionGate>
        <OverlayHost>
          <Page />
        </OverlayHost>
      </AppConnectionGate>
    </AppConnectionProvider>,
  );
  return (await screen.findByTestId("folder")).textContent;
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe("the folder the app opens on", () => {
  test("is the server's folder when nothing is remembered and the link names none", async () => {
    expect(await openedFolder("#token=t")).toBe(SERVER_FOLDER);
  });

  test("is the folder remembered from before when the link names none", async () => {
    window.localStorage.setItem(FOLDER_KEY, "/work/remembered");
    expect(await openedFolder("#token=t")).toBe("/work/remembered");
  });

  test("is the folder the link names, ahead of the one remembered from before", async () => {
    window.localStorage.setItem(FOLDER_KEY, "/work/remembered");
    expect(await openedFolder("#token=t&folder=%2Fwork%2Flaunched")).toBe("/work/launched");
  });

  test("is the folder the link names when nothing is remembered", async () => {
    expect(await openedFolder("#token=t&folder=%2Fwork%2Flaunched")).toBe("/work/launched");
  });

  test("stays the remembered folder when the link's folder is not an absolute path", async () => {
    window.localStorage.setItem(FOLDER_KEY, "/work/remembered");
    expect(await openedFolder("#token=t&folder=work%2Flaunched")).toBe("/work/remembered");
  });

  test("stays the link's folder on the next load, as for a folder picked by hand", async () => {
    window.localStorage.setItem(FOLDER_KEY, "/work/remembered");
    expect(await openedFolder("#token=t&folder=%2Fwork%2Flaunched")).toBe("/work/launched");
    cleanup();
    expect(await openedFolder("#token=t")).toBe("/work/launched");
  });
});
