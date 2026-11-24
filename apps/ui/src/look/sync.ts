import type { AppClient } from "@omp-app/client";
import { AppFailure, type AppLook, AppLookStore, type AppLookValues } from "@omp-app/contracts";
import { useSyncExternalStore } from "react";
import { groupToolsNow, setGroupTools } from "../chat/groupTools";
import { follow } from "../follow";
import { setStyle, styleNow } from "../theme/style";
import { readThemeLook, writeThemeLook } from "../theme/theme";
import { closeAfterNow, DEFAULT_CLOSE_AFTER, setCloseAfter } from "../workspace/closeIdle";
import { onLookChanged } from "./changes";

/**
 * The app's look, for every device or for this one (V258), as omp's settings are for every folder or one. A device on
 * **Every device** shows the look kept on the server (`A1.appLookStore`) and edits it: every device on Every device
 * changes with it. A device on **This device** keeps its own values in this browser and is not touched by the server's.
 *
 * The look's settings keep reading this browser's storage, as index.html's boot script does for the first paint: on
 * Every device that storage holds a copy of the server's look, and the device's own values wait aside
 * (`DEVICE_KEY`) for when it goes back to This device.
 */
export type LookScope = "global" | "device";

const SCOPE_KEY = "omp-app.ui.look.scope";
const DEVICE_KEY = "omp-app.ui.look.device";
/**
 * Set while a change made here has not been saved on the server yet: it outlives a reload or a closed tab, so the next
 * page saves its own look instead of taking the server's older one, and an older copy heard meanwhile is not shown.
 */
const UNSAVED_KEY = "omp-app.ui.look.unsaved";

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // No storage: the choice lasts until the page closes.
  }
}

/** The look as this page has it now. */
export function lookHere(): AppLookValues {
  const theme = readThemeLook();
  const hours = closeAfterNow();
  return {
    themeMode: theme.mode,
    themeLight: theme.light,
    themeDark: theme.dark,
    style: styleNow(),
    groupTools: groupToolsNow(),
    closeAfter: hours === null ? "never" : hours,
  };
}

/** Shows a look here, without hearing it as a change made here (it would go back to the server). */
function showLook(look: AppLookValues): void {
  writeThemeLook({
    ...(look.themeMode === undefined ? {} : { mode: look.themeMode }),
    ...(look.themeLight === undefined ? {} : { light: look.themeLight }),
    ...(look.themeDark === undefined ? {} : { dark: look.themeDark }),
  });
  setStyle(look.style ?? "tern", true);
  setGroupTools(look.groupTools ?? true, true);
  setCloseAfter(
    look.closeAfter === "never" ? null : (look.closeAfter ?? DEFAULT_CLOSE_AFTER),
    true,
  );
}

let scope: LookScope = read(SCOPE_KEY) === "device" ? "device" : "global";
let client: AppClient | null = null;
/** The server's look as last heard, with its revision for the next change. */
let server: AppLook | null = null;
let pushing: ReturnType<typeof setTimeout> | undefined;
/** Changes made here so far: a save clears the unsaved mark only when no change came after the look it sent. */
let changes = 0;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

/** Saves the look here as the look for every device; another device's change in between is read, then saved over. */
async function push(): Promise<void> {
  if (client === null || scope !== "global") return;
  const store = client.port(AppLookStore);
  const sent = changes;
  const look = lookHere();
  try {
    server = await store.set({
      look,
      expectedRevision: server?.revision ?? (await store.read({})).revision,
    });
  } catch (failure) {
    if (!(failure instanceof AppFailure) || failure.appError.code !== "conflict") throw failure;
    const now = await store.read({});
    server = await store.set({ look, expectedRevision: now.revision });
  }
  if (changes === sent) write(UNSAVED_KEY, null);
}

/**
 * The server's look came (read or changed): shown here while this device is on Every device, unless a change made here
 * is still to be saved, which is newer (the copy heard may be an earlier save of this very page).
 */
function heard(look: AppLook): void {
  server = look;
  if (scope === "global" && read(UNSAVED_KEY) === null) showLook(look.look);
}

/**
 * Starts keeping the look in step with the server (the full app only; the lite view has its own). The first device
 * that saves finds the server's look empty and gives it its own, so nothing on it changes; a page whose last change was
 * not saved (reloaded or closed at once) saves it now.
 */
export function startLookSync(next: AppClient): () => void {
  client = next;
  const stopChanges = onLookChanged(() => {
    if (scope !== "global") return;
    changes += 1;
    write(UNSAVED_KEY, "1");
    clearTimeout(pushing);
    pushing = setTimeout(() => void push().catch(() => undefined), 250);
  });
  const stopServer = follow(next.subscribe(AppLookStore, "changed"), heard);
  void next
    .port(AppLookStore)
    .read({})
    .then((look) => {
      if (Object.keys(look.look).length === 0 || read(UNSAVED_KEY) !== null) {
        server = look;
        if (scope === "global") void push().catch(() => undefined);
      } else heard(look);
    })
    .catch(() => undefined);
  return () => {
    clearTimeout(pushing);
    stopChanges();
    stopServer();
    if (client === next) client = null;
  };
}

/**
 * Moves this device to Every device (its own values set aside, the server's shown) or to This device (its own values
 * back, or the look it shows now when it had none set aside).
 */
export function setLookScope(next: LookScope): void {
  if (next === scope) return;
  if (next === "device") {
    const kept = read(DEVICE_KEY);
    scope = "device";
    write(SCOPE_KEY, "device");
    if (kept !== null) {
      try {
        showLook(JSON.parse(kept) as AppLookValues);
      } catch {
        // An unreadable copy: the look shown now stays as this device's own.
      }
    }
  } else {
    write(DEVICE_KEY, JSON.stringify(lookHere()));
    scope = "global";
    write(SCOPE_KEY, null);
    if (server !== null && Object.keys(server.look).length > 0) showLook(server.look);
    else void push().catch(() => undefined);
  }
  notify();
}

/** This device's scope, kept current. */
export function useLookScope(): LookScope {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => scope,
    () => "global",
  );
}
