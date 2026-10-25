import type {
  CommandDescriptor,
  ComposerDescriptor,
  Descriptor,
  DialogDescriptor,
  MessageDescriptor,
  PanelDescriptor,
  SettingDescriptor,
  StatusDescriptor,
} from "@omp-app/contracts";
import { P1CapabilityKeys } from "../contract";
import { P1_AGENT_HUB_DESCRIPTORS } from "../hub/descriptors";

/**
 * P1's registry claims: the 20 P1-group inventory rows (`P1.task-subagent-card` belongs to T5), the
 * nine advisor rows of C3 that P1 owns, and `S2.model-advisor`. Each row is covered exactly once.
 * Kinds follow the inventory: a mode is a status, a view is a panel, a custom message matches its omp
 * custom type. Rows that omp offers only in the terminal either run in the browser on a host capability
 * (advisor configuration, `model/Advisor` through A1's ConfigStore) or stay unavailable behind an
 * `upstream.*` capability (the agents dashboard), never a faked RPC result. `/hub` and Alt+A are
 * served by the browser and need no capability; Alt+A and the palette command are the hub module's
 * descriptors, reused here so the app registers the same objects this list holds.
 */

/** omp's agent-definition dashboard is terminal-only: no RPC exposes it yet (AP6). */
const AGENTS_DASHBOARD = "upstream.agents-dashboard" as const;

const P1_COMMAND_DESCRIPTORS = [
  {
    kind: "command",
    id: "P1.agentsCommand",
    owner: "P1",
    title: "Agents settings",
    covers: ["P1.agents"],
    requires: [AGENTS_DASHBOARD],
    slash: { name: "agents", source: "builtin" },
  },
  {
    kind: "command",
    id: "P1.hubCommand",
    owner: "P1",
    title: "Open the Agent Hub",
    covers: ["P1.hub"],
    requires: [],
    slash: { name: "hub", source: "builtin" },
  },
  {
    kind: "command",
    id: "P1.cancelSubagent",
    owner: "P1",
    title: "Cancel agent",
    covers: ["P1.cancel-subagent"],
    requires: [P1CapabilityKeys.cancel],
  },
  {
    kind: "command",
    id: "P1.steerSubagent",
    owner: "P1",
    title: "Message a running agent",
    covers: ["P1.steer-subagent"],
    requires: [P1CapabilityKeys.steer],
  },
  {
    kind: "command",
    id: "P1.advisor",
    owner: "P1",
    title: "Advisor",
    covers: ["C3.advisor"],
    requires: [P1CapabilityKeys.commandGateway],
    slash: { name: "advisor", source: "builtin" },
  },
  {
    kind: "command",
    id: "P1.advisorOn",
    owner: "P1",
    title: "Turn advisor on",
    covers: ["C3.advisor-on"],
    requires: [P1CapabilityKeys.commandGateway],
  },
  {
    kind: "command",
    id: "P1.advisorOff",
    owner: "P1",
    title: "Turn advisor off",
    covers: ["C3.advisor-off"],
    requires: [P1CapabilityKeys.commandGateway],
  },
  {
    kind: "command",
    id: "P1.advisorStatus",
    owner: "P1",
    title: "Advisor status",
    covers: ["C3.advisor-status"],
    requires: [P1CapabilityKeys.commandGateway],
  },
  {
    kind: "command",
    id: "P1.advisorDump",
    owner: "P1",
    title: "Copy advisor transcript",
    covers: ["C3.advisor-dump"],
    requires: [P1CapabilityKeys.commandGateway],
  },
] as const satisfies readonly CommandDescriptor[];

const P1_DIALOG_DESCRIPTORS = [
  {
    kind: "dialog",
    id: "P1.agentsHubDialog",
    owner: "P1",
    title: "Agent Hub",
    covers: ["P1.agents-hub"],
    requires: [P1CapabilityKeys.roster],
  },
  {
    kind: "dialog",
    id: "P1.agentsDashboard",
    owner: "P1",
    title: "Agents settings dashboard",
    covers: ["P1.agents-dashboard"],
    requires: [AGENTS_DASHBOARD],
  },
  {
    kind: "dialog",
    id: "P1.agentTranscriptViewer",
    owner: "P1",
    title: "Agent transcript",
    covers: ["P1.agent-transcript-viewer"],
    requires: [P1CapabilityKeys.transcript],
  },
  {
    kind: "dialog",
    id: "P1.advisorConfigure",
    owner: "P1",
    title: "Advisor settings",
    covers: ["C3.advisor-configure"],
    requires: [P1CapabilityKeys.advisorConfig],
  },
  {
    kind: "dialog",
    id: "P1.advisorConfigurationOverlay",
    owner: "P1",
    title: "Advisor configuration",
    covers: ["C3.advisor-configuration-overlay"],
    requires: [P1CapabilityKeys.advisorConfig],
  },
] as const satisfies readonly DialogDescriptor[];

const P1_PANEL_DESCRIPTORS = [
  {
    kind: "panel",
    id: "P1.agents",
    owner: "P1",
    title: "Agents",
    covers: ["P1.agent-hub-roster"],
    requires: [P1CapabilityKeys.roster],
  },
  {
    kind: "panel",
    id: "P1.agentInspector",
    owner: "P1",
    title: "Selected agent",
    covers: ["P1.agent-hub-selected-agent-inspector"],
    requires: [P1CapabilityKeys.roster],
  },
  {
    kind: "panel",
    id: "P1.agentTranscript",
    owner: "P1",
    title: "Full transcript",
    covers: ["P1.fullscreen-subagent-advisor-transcript-viewer"],
    requires: [P1CapabilityKeys.transcript],
  },
  {
    kind: "panel",
    id: "P1.agentProgress",
    owner: "P1",
    title: "Agent progress",
    covers: ["P1.subagent-progress-rows"],
    requires: [P1CapabilityKeys.subscription, P1CapabilityKeys.events],
  },
  {
    kind: "panel",
    id: "P1.agentFeed",
    owner: "P1",
    title: "Live agent updates",
    covers: ["P1.rpc-subagent-lifecycle-progress-event-feed"],
    requires: [P1CapabilityKeys.events],
  },
] as const satisfies readonly PanelDescriptor[];

const P1_STATUS_DESCRIPTORS = [
  {
    kind: "status",
    id: "P1.focusedAgent",
    owner: "P1",
    title: "Focused agent",
    covers: ["P1.focused-subagent-session"],
    requires: [P1CapabilityKeys.transcript],
  },
  {
    kind: "status",
    id: "P1.advisorMode",
    owner: "P1",
    title: "Advisor mode",
    covers: ["C3.advisor-mode"],
    requires: [P1CapabilityKeys.commandGateway],
  },
] as const satisfies readonly StatusDescriptor[];

/**
 * Each omp custom-message type has one renderer (contract change 2026-10-05). The IRC row covers the
 * incoming type; the autoreply and relay types are registered with no row of their own. omp's IRC bus
 * replaced the auto-reply model (packages/coding-agent/src/irc/bus.ts:1-12, omp v18.12.6), so irc:autoreply
 * is read from older transcripts only.
 */
const P1_MESSAGE_DESCRIPTORS = [
  {
    kind: "message",
    id: "P1.ircIncomingCard",
    owner: "P1",
    title: "Message between agents",
    covers: ["P1.irc-incoming-autoreply-relay-card"],
    requires: [],
    match: { by: "customType", customType: "irc:incoming" },
  },
  {
    kind: "message",
    id: "P1.ircAutoreplyCard",
    owner: "P1",
    title: "Automatic reply between agents",
    covers: [],
    requires: [],
    match: { by: "customType", customType: "irc:autoreply" },
  },
  {
    kind: "message",
    id: "P1.ircRelayCard",
    owner: "P1",
    title: "Message relayed between agents",
    covers: [],
    requires: [],
    match: { by: "customType", customType: "irc:relay" },
  },
  {
    kind: "message",
    id: "P1.asyncJobCompletedRow",
    owner: "P1",
    title: "Background job finished",
    covers: ["P1.background-job-completed-row"],
    requires: [],
    match: { by: "customType", customType: "async-result" },
  },
  {
    kind: "message",
    id: "P1.tangentDispatchBreadcrumb",
    owner: "P1",
    title: "Background tangent started",
    covers: ["P1.background-tangent-dispatch-breadcrumb"],
    requires: [],
    match: { by: "customType", customType: "background-tan-dispatch" },
  },
  {
    kind: "message",
    id: "P1.liveDelegationMessage",
    owner: "P1",
    title: "Live delegation request",
    covers: ["P1.live-delegation-message"],
    requires: [],
    match: { by: "customType", customType: "live-delegation" },
  },
  {
    kind: "message",
    id: "P1.launchCompletionRow",
    owner: "P1",
    title: "Process finished",
    covers: ["P1.supervised-process-completion-row"],
    requires: [],
    match: { by: "customType", customType: "launch-completion" },
  },
  {
    kind: "message",
    id: "P1.advisorNoteCard",
    owner: "P1",
    title: "Advisor note",
    covers: ["C3.advisor-note-card"],
    requires: [],
    match: { by: "customType", customType: "advisor" },
  },
] as const satisfies readonly MessageDescriptor[];

/** Double Left on an empty composer opens the Agent Hub; the browser handles the gesture itself. */
const P1_COMPOSER_DESCRIPTORS = [
  {
    kind: "composer",
    id: "P1.doubleLeftGesture",
    owner: "P1",
    title: "Double Left arrow opens the Agent Hub",
    covers: ["P1.double-left-agent-hub-gesture"],
    requires: [],
    feature: { slot: "gesture" },
  },
] as const satisfies readonly ComposerDescriptor[];

/**
 * The advisor's section of omp settings. The descriptor names the group by `advisor.enabled`, its
 * first pin (research/omp-storage-and-config.md, the advisor pins); the other six pins sit in the same
 * section. Writes go through A1's ConfigStore, which needs `host.config`.
 */
const P1_SETTING_DESCRIPTORS = [
  {
    kind: "setting",
    id: "P1.advisorSettings",
    owner: "P1",
    title: "Advisor settings section",
    covers: ["S2.model-advisor"],
    requires: [P1CapabilityKeys.advisorConfig],
    key: "advisor.enabled",
    section: "model/Advisor",
  },
] as const satisfies readonly SettingDescriptor[];

/** Every P1 descriptor, in one list the composition index collects. */
export const P1_DESCRIPTORS = [
  ...P1_AGENT_HUB_DESCRIPTORS,
  ...P1_COMMAND_DESCRIPTORS,
  ...P1_DIALOG_DESCRIPTORS,
  ...P1_PANEL_DESCRIPTORS,
  ...P1_STATUS_DESCRIPTORS,
  ...P1_MESSAGE_DESCRIPTORS,
  ...P1_COMPOSER_DESCRIPTORS,
  ...P1_SETTING_DESCRIPTORS,
] as const satisfies readonly Descriptor[];
