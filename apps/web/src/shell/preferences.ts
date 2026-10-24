/**
 * App-owned shell layout preferences. These values belong to the browser UI, not omp's config
 * files: the shell persists its two sidebar widths and whether the wide layout's right panel is open,
 * and keeps the widths bounded before rendering.
 */
import { useCallback, useEffect, useState } from "react";

export const SHELL_PREFERENCES_STORAGE_KEY = "omp.app.shell.preferences";

const MIN_SIDEBAR_WIDTH = 14;
const MAX_SIDEBAR_WIDTH = 32;
const DEFAULT_LEFT_SIDEBAR_WIDTH = 15;
const DEFAULT_RIGHT_SIDEBAR_WIDTH = 18;

export interface ShellPreferences {
  readonly leftSidebarWidth: number;
  readonly rightSidebarWidth: number;
  /** The wide layout's right panel: closed on a first visit, then as the person last left it. */
  readonly rightSidebarOpen: boolean;
}

/** The two sidebar widths a person can drag. */
type SidebarWidthKey = "leftSidebarWidth" | "rightSidebarWidth";

export type ShellPersistenceStatus = "ready" | "unavailable";

export interface ShellPreferencesState {
  readonly preferences: ShellPreferences;
  readonly persistenceStatus: ShellPersistenceStatus;
  readonly setLeftSidebarWidth: (width: number) => void;
  readonly setRightSidebarWidth: (width: number) => void;
  readonly setRightSidebarOpen: (open: boolean) => void;
}

const DEFAULT_PREFERENCES: ShellPreferences = Object.freeze({
  leftSidebarWidth: DEFAULT_LEFT_SIDEBAR_WIDTH,
  rightSidebarWidth: DEFAULT_RIGHT_SIDEBAR_WIDTH,
  rightSidebarOpen: false,
});

function clampSidebarWidth(width: number, fallback: number): number {
  if (!Number.isFinite(width)) return fallback;
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, width));
}

function readStoredPreferences(): {
  readonly preferences: ShellPreferences;
  readonly persistenceStatus: ShellPersistenceStatus;
} {
  if (typeof window === "undefined") {
    return { preferences: DEFAULT_PREFERENCES, persistenceStatus: "ready" };
  }

  try {
    const raw = window.localStorage.getItem(SHELL_PREFERENCES_STORAGE_KEY);
    if (raw === null) return { preferences: DEFAULT_PREFERENCES, persistenceStatus: "ready" };

    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { preferences: DEFAULT_PREFERENCES, persistenceStatus: "ready" };
    }

    const candidate = parsed as {
      readonly leftSidebarWidth?: unknown;
      readonly rightSidebarWidth?: unknown;
      readonly rightSidebarOpen?: unknown;
    };
    const leftWidth =
      typeof candidate.leftSidebarWidth === "number" ? candidate.leftSidebarWidth : Number.NaN;
    const rightWidth =
      typeof candidate.rightSidebarWidth === "number" ? candidate.rightSidebarWidth : Number.NaN;
    return {
      preferences: {
        leftSidebarWidth: clampSidebarWidth(leftWidth, DEFAULT_LEFT_SIDEBAR_WIDTH),
        rightSidebarWidth: clampSidebarWidth(rightWidth, DEFAULT_RIGHT_SIDEBAR_WIDTH),
        rightSidebarOpen: candidate.rightSidebarOpen === true,
      },
      persistenceStatus: "ready",
    };
  } catch {
    return { preferences: DEFAULT_PREFERENCES, persistenceStatus: "unavailable" };
  }
}

/** Reads, bounds, and persists the shell's layout preferences: the two sidebar widths and the right panel's state. */
export function useShellPreferences(): ShellPreferencesState {
  const [{ preferences, persistenceStatus: initialStatus }, setInitialState] =
    useState(readStoredPreferences);
  const [persistenceStatus, setPersistenceStatus] = useState<ShellPersistenceStatus>(initialStatus);

  useEffect(() => {
    if (typeof window === "undefined") return;

    try {
      window.localStorage.setItem(SHELL_PREFERENCES_STORAGE_KEY, JSON.stringify(preferences));
      setPersistenceStatus("ready");
    } catch {
      setPersistenceStatus("unavailable");
    }
  }, [preferences]);

  const setWidth = useCallback((key: SidebarWidthKey, width: number) => {
    setInitialState((state) => ({
      ...state,
      preferences: {
        ...state.preferences,
        [key]: clampSidebarWidth(width, state.preferences[key]),
      },
    }));
  }, []);

  const setLeftSidebarWidth = useCallback(
    (width: number) => setWidth("leftSidebarWidth", width),
    [setWidth],
  );
  const setRightSidebarWidth = useCallback(
    (width: number) => setWidth("rightSidebarWidth", width),
    [setWidth],
  );
  const setRightSidebarOpen = useCallback((open: boolean) => {
    setInitialState((state) => ({
      ...state,
      preferences: { ...state.preferences, rightSidebarOpen: open },
    }));
  }, []);

  return {
    preferences,
    persistenceStatus,
    setLeftSidebarWidth,
    setRightSidebarWidth,
    setRightSidebarOpen,
  };
}
