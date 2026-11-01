import type { IDockviewPanel, IDockviewPanelHeaderProps } from "dockview-react";
import { GripVertical, Pause } from "lucide-react";
import { type ReactNode, use, useSyncExternalStore } from "react";
import { forgetNewChatDraft } from "../chat/drafts";
import { type ChatPanelParams, mouseClickTakesCaret, PaneHostContext } from "./ChatPanel";

/** The chat a pane was given, which names the key its new chat's text is kept under. */
export const chatOfPane = (params: unknown): string | undefined =>
  (params as ChatPanelParams | undefined)?.chat;

/**
 * Closes a pane the person asked to close. Only then does its new chat's text, kept under the pane's key for a reload
 * that reopens the pane, go: layout rebuilds, moves and reloads close panes too, and keep that text.
 */
export function closePaneAsked(panel: IDockviewPanel): void {
  const chat = chatOfPane(panel.params);
  if (chat !== undefined) void forgetNewChatDraft(chat);
  panel.api.close();
}

/**
 * A pane's tab in its title bar: dockview's own default tab (its title, and a close button named after it), whose close
 * button closes the pane as asked. dockview's default tab cannot be told to do that, so this one draws the same. A
 * click on the title puts the caret in the pane's message box, so the pane's keys reach the pane it chose. A grip (⠿)
 * starts the title: the tab is where a pane is taken to move it, onto the docking guides (#2771). A paused chat (omp's
 * `/pause`) has a pause mark before its title.
 */
export function PaneTab({ api, containerApi }: IDockviewPanelHeaderProps): ReactNode {
  const host = use(PaneHostContext);
  const title = useSyncExternalStore(
    (notify) => {
      const subscription = api.onDidTitleChange(notify);
      return () => subscription.dispose();
    },
    () => api.title ?? "",
  );
  const store = host?.controllers.get(api.id)?.store;
  const paused = useSyncExternalStore(
    (notify) => store?.subscribe(notify) ?? (() => undefined),
    () => (store?.getSnapshot().pausedAt ?? null) !== null,
  );
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: a click only puts the caret in the message box, as Tab does
    // biome-ignore lint/a11y/useKeyWithClickEvents: the keyboard reaches the message box with Tab
    <div
      className="dv-default-tab"
      onClick={(event) => {
        if (mouseClickTakesCaret(event)) host?.focus.request(api.id);
      }}
    >
      <div className="dv-default-tab-content">
        <GripVertical
          aria-hidden="true"
          className="mr-1 inline size-3.5 cursor-grab align-[-2px] text-t3"
        />
        {paused && (
          <>
            <Pause aria-hidden="true" className="mr-1 inline size-3 align-[-1px] text-warn-ink" />
            <span className="sr-only">Paused: </span>
          </>
        )}
        {title}
      </div>
      <button
        type="button"
        tabIndex={-1}
        className="dv-default-tab-action"
        aria-label={
          title === ""
            ? containerApi.messages.closeTabPlain()
            : containerApi.messages.closeTab(title)
        }
        onPointerDown={(event) => event.preventDefault()}
        onClick={(event) => {
          event.preventDefault();
          const panel = containerApi.getPanel(api.id);
          if (panel !== undefined) closePaneAsked(panel);
        }}
      >
        <svg
          width="11"
          height="11"
          viewBox="0 0 28 28"
          aria-hidden="true"
          focusable="false"
          className="dv-svg"
        >
          <path d="M2.1 27.3L0 25.2L11.55 13.65L0 2.1L2.1 0L13.65 11.55L25.2 0L27.3 2.1L15.75 13.65L27.3 25.2L25.2 27.3L13.65 15.75L2.1 27.3Z" />
        </svg>
      </button>
    </div>
  );
}
