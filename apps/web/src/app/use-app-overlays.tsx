import type { CapabilityMap, FolderPath, ThreadId } from "@omp-app/contracts";
import { useCallback, useMemo } from "react";
import type { AppConnectionSnapshot } from "@/launch";
import type { OverlayHostApi } from "@/overlay";
import { idleCommandHandlers } from "@/palette/idle-commands";
import { setThemePreference } from "@/theme";
import { openProviderSignIn } from "./provider-login-section";
import { createSettingsClosedSignal } from "./settings-closed-signal";
import { SettingsScreen } from "./settings-screen";
import { RunOnExit } from "./thread-chrome";

/**
 * The frame's height from its first frame, not the height its content has reached so far: the settings load after
 * the frame opens, and a frame that grew with them moved its top edge (issue 2584). H is 45 rem (720 px), measured
 * on origin/main at 1280 by 900: every Settings tab loads to that height, the window's 80% cap. The tabs scroll
 * inside it, and the window's 80dvh cap still applies on shorter windows.
 */
const SETTINGS_FRAME_HEIGHT = "h-[min(45rem,calc(100dvh-4rem))]";
/**
 * The settings frame is 60 rem (960 px at the default size) and never wider than 94% of the window,
 * so a phone still shows a margin. It does not scroll: its panel's body does, so the title stays whole.
 * Its one grid column may be narrower than the header's content (`minmax(0, 1fr)`), so the header's
 * Close button stays inside the frame at 200% zoom on a phone, and the title truncates instead.
 */
const SETTINGS_FRAME_WIDTH =
  "w-[min(60rem,94vw)] max-w-none grid-cols-[minmax(0,1fr)] overflow-hidden p-0";
const SETTINGS_FRAME_CLASS = `${SETTINGS_FRAME_HEIGHT} ${SETTINGS_FRAME_WIDTH}`;

interface AppOverlaysInput {
  readonly overlay: OverlayHostApi;
  readonly capabilities: CapabilityMap;
  readonly client: NonNullable<AppConnectionSnapshot["client"]>;
  readonly folder: FolderPath | null;
  readonly startChat: () => Promise<ThreadId>;
}

export function useAppOverlays({
  overlay,
  capabilities,
  client,
  folder,
  startChat,
}: AppOverlaysInput) {
  // Settings saves through its own runtime; the external signal refreshes only the paste reader after the exit.
  const settingsClosed = useMemo(() => createSettingsClosedSignal(), []);
  const openSettings = useCallback(
    (threadId: ThreadId | null, restoreFocus?: HTMLElement) => {
      overlay.open({
        kind: "modal",
        label: "Settings",
        ...(restoreFocus === undefined ? {} : { restoreFocus }),
        width: "viewport",
        className: SETTINGS_FRAME_CLASS,
        content: ({ close, requestClose, update }) => (
          <RunOnExit onExit={() => settingsClosed.bump()}>
            <SettingsScreen
              capabilities={capabilities}
              client={client}
              folder={folder}
              threadId={threadId}
              onClose={() => requestClose()}
              onUnsavedChange={(unsavedChanges) => update({ unsavedChanges })}
              onStartChat={async () => {
                const started = await startChat();
                close("programmatic");
                openProviderSignIn({ overlay, client, threadId: started, capabilities });
              }}
            />
          </RunOnExit>
        ),
      });
    },
    [capabilities, client, folder, overlay, settingsClosed, startChat],
  );
  // The palette's commands with no chat open (see `idleCommandHandlers`). Once a chat opens, its own host takes over.
  const idleHandlers = useMemo(
    () =>
      idleCommandHandlers({
        newChat: async () => {
          await startChat();
        },
        openSettings: () => openSettings(null),
        setTheme: setThemePreference,
      }),
    [openSettings, startChat],
  );
  return { settingsClosed, openSettings, idleHandlers };
}
