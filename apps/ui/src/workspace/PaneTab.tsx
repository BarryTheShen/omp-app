import type { IDockviewPanel, IDockviewPanelHeaderProps } from "dockview-react";
import { type ReactNode, useSyncExternalStore } from "react";
import { forgetNewChatDraft } from "../chat/drafts";
import type { ChatPanelParams } from "./ChatPanel";

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
 * button closes the pane as asked. dockview's default tab cannot be told to do that, so this one draws the same.
 */
export function PaneTab({ api, containerApi }: IDockviewPanelHeaderProps): ReactNode {
  const title = useSyncExternalStore(
    (notify) => {
      const subscription = api.onDidTitleChange(notify);
      return () => subscription.dispose();
    },
    () => api.title ?? "",
  );
  return (
    <div className="dv-default-tab">
      <div className="dv-default-tab-content">{title}</div>
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
