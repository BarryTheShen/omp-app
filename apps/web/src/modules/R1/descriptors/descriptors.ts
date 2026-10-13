import type { Descriptor, ShortcutDescriptor } from "@omp-app/contracts";

/** The scope of the session list's chords, and the focus scope of the list element that carries them. */
export const R1_SESSION_LIST_SCOPE = "session-list";

type SessionListShortcutDescriptor = ShortcutDescriptor & {
  readonly focus: typeof R1_SESSION_LIST_SCOPE;
};

/**
 * R1's descriptor set covers F3.open-session and the D2 session-browser rows that a command, a dialog or a
 * session-list chord realises. The other D2 rows have no descriptor: New chat and Enter in the list are
 * native controls, and fork, observe and the path and sort toggles are not offered. `fixtures/native-catalog.ts`
 * records each of them. D5/C2 command surfaces, P3/P4 tree rows, U4 dialogs and N1 notices remain owned elsewhere.
 */
export const R1_DESCRIPTORS = [
  {
    kind: "command",
    id: "R1.openSession",
    owner: "R1",
    title: "Open session",
    covers: ["F3.open-session"],
    requires: ["omp.cmd.open_session"],
  },
  {
    kind: "command",
    id: "R1.resume",
    owner: "R1",
    title: "Resume session",
    covers: ["D2.resume"],
    requires: ["host.session-files"],
    slash: { name: "resume", source: "builtin" },
  },
  {
    kind: "dialog",
    id: "R1.sessionDeleteConfirmation",
    owner: "R1",
    title: "Confirm session deletion",
    covers: ["D2.session-delete-confirmation"],
    requires: ["host.session-files", "host.command-gateway"],
  },
  {
    kind: "dialog",
    id: "R1.sessionPinAccountSelector",
    owner: "R1",
    title: "Choose pin account",
    covers: ["D2.session-pin-account-selector"],
    requires: ["host.session-pins"],
  },
  {
    kind: "dialog",
    id: "R1.sessionSelector",
    owner: "R1",
    title: "Session selector",
    covers: ["D2.session-selector"],
    requires: ["host.session-files"],
  },
  {
    kind: "shortcut",
    id: "R1.sessionDelete",
    owner: "R1",
    title: "Delete session",
    covers: ["D2.app-session-delete"],
    requires: ["host.session-files", "host.command-gateway"],
    chord: "Mod+Shift+Backspace",
    scope: R1_SESSION_LIST_SCOPE,
    focus: R1_SESSION_LIST_SCOPE,
  },
  {
    kind: "shortcut",
    id: "R1.sessionDeleteNoninvasive",
    owner: "R1",
    title: "Delete session without confirmation",
    covers: ["D2.app-session-deletenoninvasive"],
    requires: ["host.session-files", "host.command-gateway"],
    chord: "Mod+Backspace",
    scope: R1_SESSION_LIST_SCOPE,
    focus: R1_SESSION_LIST_SCOPE,
  },
  {
    kind: "shortcut",
    id: "R1.sessionRename",
    owner: "R1",
    title: "Rename session",
    covers: ["D2.app-session-rename"],
    requires: ["omp.cmd.set_session_name"],
    chord: "F2",
    scope: R1_SESSION_LIST_SCOPE,
    focus: R1_SESSION_LIST_SCOPE,
  },
] as const satisfies readonly (Descriptor | SessionListShortcutDescriptor)[];
