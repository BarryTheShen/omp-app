/**
 * The part of Firefox's WebExtension API (`browser.*`) the extension uses, typed from MDN's reference: only what is
 * called, so a typing never promises more than the extension relies on.
 */
declare namespace browser {
  interface Listener<T extends (...args: never[]) => unknown> {
    addListener(callback: T): void;
    removeListener(callback: T): void;
  }

  namespace runtime {
    interface MessageSender {
      readonly tab?: tabs.Tab;
      readonly frameId?: number;
      readonly id?: string;
    }
    function getURL(path: string): string;
    function openOptionsPage(): Promise<void>;
    function sendMessage(message: unknown): Promise<unknown>;
    const onMessage: Listener<(message: unknown, sender: MessageSender) => void>;
  }

  namespace tabs {
    interface Tab {
      readonly id?: number;
      readonly windowId: number;
      readonly url?: string;
      readonly title?: string;
      readonly active: boolean;
      readonly status?: string;
    }
    interface ChangeInfo {
      readonly status?: string;
      readonly url?: string;
      readonly title?: string;
    }
    function get(tabId: number): Promise<Tab>;
    function query(query: { active?: boolean; currentWindow?: boolean }): Promise<Tab[]>;
    function update(tabId: number, properties: { url?: string; active?: boolean }): Promise<Tab>;
    function create(properties: {
      url: string;
      active?: boolean;
      openerTabId?: number;
      windowId?: number;
    }): Promise<Tab>;
    function captureVisibleTab(
      windowId: number,
      options: { format: "png" | "jpeg"; quality?: number },
    ): Promise<string>;
    const onUpdated: Listener<(tabId: number, change: ChangeInfo, tab: Tab) => void>;
    const onRemoved: Listener<(tabId: number) => void>;
  }

  namespace scripting {
    interface InjectionResult<R> {
      readonly result?: R;
      readonly error?: unknown;
    }
    function executeScript<A extends unknown[], R>(details: {
      target: { tabId: number };
      func: (...args: A) => R;
      args?: A;
    }): Promise<InjectionResult<Awaited<R>>[]>;
  }

  namespace storage {
    interface Area {
      get(keys: string | string[]): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
      remove(keys: string | string[]): Promise<void>;
    }
    const local: Area;
    const session: Area;
  }

  namespace sidebarAction {
    function setPanel(details: { panel: string | null; tabId?: number }): Promise<void>;
    function open(): Promise<void>;
  }

  namespace action {
    const onClicked: Listener<(tab: tabs.Tab) => void>;
  }
}
