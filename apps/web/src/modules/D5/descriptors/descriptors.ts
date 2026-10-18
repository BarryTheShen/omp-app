import type {
  CommandDescriptor,
  Descriptor,
  DialogDescriptor,
  MessageDescriptor,
} from "@omp-app/contracts";
import { D5_COMMAND_CAPABILITIES } from "../contract";
import { D5_LIFECYCLE_COMMAND_DESCRIPTORS } from "../descriptors";
import { SESSION_LIFECYCLE_CAPABILITIES } from "../lifecycle";
import { RECOVERY_CAPABILITIES } from "../recovery/controller";
import { WORKSPACE_CAPABILITIES } from "../workspace/models";

const SESSION = ["omp.cmd.get_state"] as const;
const SSH = [WORKSPACE_CAPABILITIES.commands] as const;
const WORKSPACE = [WORKSPACE_CAPABILITIES.state, WORKSPACE_CAPABILITIES.commands] as const;

export const D5_SESSION_COMMAND_DESCRIPTORS = [
  {
    kind: "command",
    id: "D5.session",
    owner: "D5",
    title: "Session details",
    covers: ["C1.session", "C1.session-info"],
    requires: [...SESSION],
    slash: { name: "session", source: "builtin" },
  },
  {
    kind: "command",
    id: "D5.delete",
    owner: "D5",
    title: "Delete chat",
    covers: ["C1.session-delete", "C2.delete"],
    requires: [D5_COMMAND_CAPABILITIES.delete],
    slash: { name: "delete", source: "builtin" },
  },
  {
    kind: "command",
    id: "D5.pin",
    owner: "D5",
    title: "Pin chat",
    covers: ["C1.session-pin", "C2.pin"],
    requires: [D5_COMMAND_CAPABILITIES.pin],
    slash: { name: "pin", source: "builtin" },
  },
  {
    kind: "command",
    id: "D5.rename",
    owner: "D5",
    title: "Rename chat",
    covers: ["C2.rename"],
    requires: [D5_COMMAND_CAPABILITIES.rename],
    slash: { name: "rename", source: "builtin" },
  },
] as const satisfies readonly CommandDescriptor[];

export const D5_SSH_COMMAND_DESCRIPTORS = [
  {
    kind: "command",
    id: "D5.ssh",
    owner: "D5",
    title: "Manage SSH hosts",
    covers: ["C1.ssh"],
    requires: [...SSH],
    slash: { name: "ssh", source: "builtin" },
  },
  {
    kind: "command",
    id: "D5.sshAdd",
    owner: "D5",
    title: "Add SSH host",
    covers: ["C1.ssh-add"],
    requires: [...SSH],
  },
  {
    kind: "command",
    id: "D5.sshHelp",
    owner: "D5",
    title: "SSH help",
    covers: ["C1.ssh-help"],
    requires: [...SSH],
  },
  {
    kind: "command",
    id: "D5.sshList",
    owner: "D5",
    title: "List SSH hosts",
    covers: ["C1.ssh-list"],
    requires: [...SSH],
  },
  {
    kind: "command",
    id: "D5.sshRemove",
    owner: "D5",
    title: "Remove SSH host",
    covers: ["C1.ssh-remove"],
    requires: [...SSH],
  },
] as const satisfies readonly CommandDescriptor[];

export const D5_WORKSPACE_COMMAND_DESCRIPTORS = [
  {
    kind: "command",
    id: "D5.addDirectory",
    owner: "D5",
    title: "Add workspace folder",
    covers: ["C2.add-dir"],
    requires: [...WORKSPACE],
    slash: { name: "add-dir", source: "builtin" },
  },
  {
    kind: "command",
    id: "D5.listDirectories",
    owner: "D5",
    title: "List workspace folders",
    covers: ["C2.dirs"],
    requires: [...WORKSPACE],
    slash: { name: "dirs", source: "builtin" },
  },
  {
    kind: "command",
    id: "D5.removeDirectory",
    owner: "D5",
    title: "Remove workspace folder",
    covers: ["C2.remove-dir"],
    requires: [...WORKSPACE],
    slash: { name: "remove-dir", source: "builtin" },
  },
  {
    kind: "command",
    id: "D5.moveSession",
    owner: "D5",
    title: "Move chat folder",
    covers: ["C2.move"],
    requires: [...WORKSPACE],
    slash: { name: "move", source: "builtin" },
  },
  {
    kind: "command",
    id: "D5.worktree",
    owner: "D5",
    title: "Move chat to a worktree",
    covers: ["C2.wt"],
    requires: [WORKSPACE_CAPABILITIES.worktree],
    slash: { name: "wt", source: "builtin" },
  },
  {
    kind: "command",
    id: "D5.restart",
    owner: "D5",
    title: "Restart omp",
    covers: ["C2.restart"],
    requires: [WORKSPACE_CAPABILITIES.commands],
    slash: { name: "restart", source: "builtin" },
  },
] as const satisfies readonly CommandDescriptor[];

export const D5_RECOVERY_COMMAND_DESCRIPTORS = [
  {
    kind: "command",
    id: "D5.handoff",
    owner: "D5",
    title: "Hand off conversation",
    covers: ["C2.handoff"],
    requires: [RECOVERY_CAPABILITIES.handoff],
    slash: { name: "handoff", source: "builtin" },
  },
  {
    kind: "command",
    id: "D5.retry",
    owner: "D5",
    title: "Retry failed reply",
    covers: ["C2.retry"],
    requires: [RECOVERY_CAPABILITIES.retry],
    slash: { name: "retry", source: "builtin" },
  },
] as const satisfies readonly CommandDescriptor[];

export const D5_NAMESPACE_COMMAND_DESCRIPTORS = [
  {
    kind: "command",
    id: "D5.newNamespace",
    owner: "D5",
    title: "New chat command",
    covers: [],
    requires: [SESSION_LIFECYCLE_CAPABILITIES.new],
    slash: { name: "new", source: "builtin" },
  },
  {
    kind: "command",
    id: "D5.clearNamespace",
    owner: "D5",
    title: "Clear conversation command",
    covers: [],
    requires: [SESSION_LIFECYCLE_CAPABILITIES.clear],
    slash: { name: "clear", source: "builtin" },
  },
] as const satisfies readonly CommandDescriptor[];

export const D5_DIALOG_DESCRIPTORS = [
  {
    kind: "dialog",
    id: "D5.moveDirectoryOverlay",
    owner: "D5",
    title: "Move chat folder",
    covers: ["C2.move-directory-overlay"],
    requires: [...WORKSPACE],
  },
] as const satisfies readonly DialogDescriptor[];

export const D5_MESSAGE_DESCRIPTORS = [
  {
    kind: "message",
    id: "D5.handoffSummaryDivider",
    owner: "D5",
    title: "Handoff summary",
    covers: ["C2.handoff-summary-divider"],
    requires: [RECOVERY_CAPABILITIES.handoff],
    match: { by: "customType", customType: "handoff-summary" },
  },
] as const satisfies readonly MessageDescriptor[];

/** All D5 descriptors, including the lifecycle descriptors from the earlier part. */
export const D5_DESCRIPTORS: readonly Descriptor[] = [
  ...D5_LIFECYCLE_COMMAND_DESCRIPTORS,
  ...D5_SESSION_COMMAND_DESCRIPTORS,
  ...D5_SSH_COMMAND_DESCRIPTORS,
  ...D5_WORKSPACE_COMMAND_DESCRIPTORS,
  ...D5_RECOVERY_COMMAND_DESCRIPTORS,
  ...D5_NAMESPACE_COMMAND_DESCRIPTORS,
  ...D5_DIALOG_DESCRIPTORS,
  ...D5_MESSAGE_DESCRIPTORS,
];
