import type {
  CapabilityKey,
  CommandDescriptor,
  Descriptor,
  DialogDescriptor,
  PanelDescriptor,
} from "@omp-app/contracts";

/** Capabilities used by D6's gateway-backed diagnostics and local fallback surfaces. */
export const D6_CAPABILITIES = {
  commandGateway: "host.command-gateway",
  fallback: "client.d6-fallback",
} as const satisfies Record<string, CapabilityKey>;

const GATEWAY = D6_CAPABILITIES.commandGateway;
const FALLBACK = D6_CAPABILITIES.fallback;

/** C1 rows not already owned by D6.3's palette commands. */
export const D6_COMMAND_DESCRIPTORS = [
  {
    kind: "command",
    id: "D6.changelogFull",
    owner: "D6",
    title: "Show full changelog",
    covers: ["C1.changelog-full"],
    requires: [GATEWAY],
  },
  {
    kind: "command",
    id: "D6.debug",
    owner: "D6",
    title: "Open debug tools",
    covers: ["C1.debug"],
    requires: [FALLBACK],
  },
  {
    kind: "command",
    id: "D6.jobsFull",
    owner: "D6",
    title: "Show full job output",
    covers: ["C1.jobs-full"],
    requires: [GATEWAY],
  },
  {
    kind: "command",
    id: "D6.securityCancel",
    owner: "D6",
    title: "Cancel security scan",
    covers: ["C1.security-cancel"],
    requires: [GATEWAY],
  },
  {
    kind: "command",
    id: "D6.securityCompare",
    owner: "D6",
    title: "Compare security scans",
    covers: ["C1.security-compare"],
    requires: [GATEWAY],
  },
  {
    kind: "command",
    id: "D6.securityDisposition",
    owner: "D6",
    title: "Set finding disposition",
    covers: ["C1.security-disposition"],
    requires: [GATEWAY],
  },
  {
    kind: "command",
    id: "D6.securityExport",
    owner: "D6",
    title: "Export security findings",
    covers: ["C1.security-export"],
    requires: [GATEWAY],
  },
  {
    kind: "command",
    id: "D6.securityImport",
    owner: "D6",
    title: "Import security findings",
    covers: ["C1.security-import"],
    requires: [GATEWAY],
  },
  {
    kind: "command",
    id: "D6.securityPlan",
    owner: "D6",
    title: "Plan a security scan",
    covers: ["C1.security-plan"],
    requires: [GATEWAY],
  },
  {
    kind: "command",
    id: "D6.securityScan",
    owner: "D6",
    title: "Run a security scan",
    covers: ["C1.security-scan"],
    requires: [GATEWAY],
  },
  {
    kind: "command",
    id: "D6.securityScans",
    owner: "D6",
    title: "List security scans",
    covers: ["C1.security-scans"],
    requires: [GATEWAY],
  },
  {
    kind: "command",
    id: "D6.securityShow",
    owner: "D6",
    title: "Show security findings",
    covers: ["C1.security-show"],
    requires: [GATEWAY],
  },
  {
    kind: "command",
    id: "D6.securityStatus",
    owner: "D6",
    title: "Show security status",
    covers: ["C1.security-status"],
    requires: [GATEWAY],
  },
  {
    kind: "command",
    id: "D6.securityValidate",
    owner: "D6",
    title: "Validate security findings",
    covers: ["C1.security-validate"],
    requires: [GATEWAY],
  },
] as const satisfies readonly CommandDescriptor[];

/** App-side C3 action descriptors; their ids are not slash-command catalog names. */
export const D6_OPERATION_COMMAND_DESCRIPTORS = [
  {
    kind: "command",
    id: "D6.btwCommand",
    owner: "D6",
    title: "Open side questions",
    covers: ["C3.btw"],
    requires: [FALLBACK],
  },
  {
    kind: "command",
    id: "D6.cleanseCommand",
    owner: "D6",
    title: "Open cleanse progress",
    covers: ["C3.cleanse"],
    requires: [FALLBACK],
  },
  {
    kind: "command",
    id: "D6.omfgCommand",
    owner: "D6",
    title: "Open rule draft",
    covers: ["C3.omfg"],
    requires: [FALLBACK],
  },
  {
    kind: "command",
    id: "D6.pauseCommand",
    owner: "D6",
    title: "Open pause screen",
    covers: ["C3.pause"],
    requires: [FALLBACK],
  },
] as const satisfies readonly CommandDescriptor[];

export const D6_PANEL_DESCRIPTORS = [
  {
    kind: "panel",
    id: "D6.btw",
    owner: "D6",
    title: "Side questions",
    covers: ["C3.btw-side-panel"],
    requires: [FALLBACK],
  },
  {
    kind: "panel",
    id: "D6.cleanse",
    owner: "D6",
    title: "Cleanse",
    covers: ["C3.cleanse-progress-panel"],
    requires: [FALLBACK],
  },
  {
    kind: "panel",
    id: "D6.omfg",
    owner: "D6",
    title: "Rule draft",
    covers: ["C3.omfg-rule-panel"],
    requires: [FALLBACK],
  },
  {
    kind: "panel",
    id: "D6.reportPanel",
    owner: "D6",
    title: "Reports",
    covers: ["C1.report-panel"],
    requires: [FALLBACK],
  },
] as const satisfies readonly PanelDescriptor[];

export const D6_DIALOG_DESCRIPTORS = [
  {
    kind: "dialog",
    id: "D6.debugSelector",
    owner: "D6",
    title: "Debug tools",
    covers: ["C3.debug-selector"],
    requires: [FALLBACK],
  },
  {
    kind: "dialog",
    id: "D6.pauseGate",
    owner: "D6",
    title: "Pause controls",
    covers: ["C3.pause-gate"],
    requires: [FALLBACK],
  },
  {
    kind: "dialog",
    id: "D6.pauseScreen",
    owner: "D6",
    title: "Pause screen",
    covers: ["C3.pause-screen"],
    requires: [FALLBACK],
  },
] as const satisfies readonly DialogDescriptor[];

export const D6_DESCRIPTORS = [
  ...D6_COMMAND_DESCRIPTORS,
  ...D6_OPERATION_COMMAND_DESCRIPTORS,
  ...D6_PANEL_DESCRIPTORS,
  ...D6_DIALOG_DESCRIPTORS,
] as const satisfies readonly Descriptor[];

export type D6Descriptor = (typeof D6_DESCRIPTORS)[number];
