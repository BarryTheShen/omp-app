import type {
  Descriptor,
  MessageDescriptor,
  NoticeDescriptor,
  SettingDescriptor,
  StatusDescriptor,
} from "@omp-app/contracts";
import type { SettingsSectionDescriptor } from "../../S1/settings-kit";
import { P7_COMMAND_DESCRIPTORS } from "../commands/descriptors";
import { P7_CONTEXT_SETTINGS_SECTIONS } from "../settings/descriptors";

/**
 * Registry descriptors for the P7 inventory rows the command and settings parts do not claim. The
 * command rows (P4 `/context`, `/stats`, `/usage`, E4 `/compact`) are claimed in `commands/`, and the
 * four S4 Context sections in `settings/`. Each row here is claimed once; `test/descriptors.test.ts`
 * checks that across the whole module.
 *
 * Kinds follow where P7 draws each row. Status segments are the status bar (context percent and
 * size) and the usage popover (token, cache and cost totals, the last turn, provider limits). Two
 * rows are kept on kinds that fit what P7 draws, not on the inventory's own kind: the cache-miss
 * divider is drawn inline above a cold turn, and the per-turn usage row is the "Last turn" table in
 * the usage popover. Neither has an omp message role, so a message descriptor cannot name them
 * without claiming U1's `assistant` role.
 */

/** Context usage comes from omp's `get_state` (`contextUsage`, `tokensPerSecond`). */
const GET_STATE = ["omp.cmd.get_state"] as const;
/** Session totals come from omp's `get_session_stats`. */
const SESSION_STATS = ["omp.cmd.get_session_stats"] as const;

export const P7_STATUS_DESCRIPTORS = [
  {
    kind: "status",
    id: "P7.status-context-percent",
    owner: "P7",
    title: "Context used percentage",
    covers: ["P4.context-pct"],
    requires: [...GET_STATE],
  },
  {
    kind: "status",
    id: "P7.status-context-size",
    owner: "P7",
    title: "Context tokens of the window",
    covers: ["P4.context-total"],
    requires: [...GET_STATE],
  },
  {
    kind: "status",
    id: "P7.status-token-rate",
    owner: "P7",
    title: "Tokens per second",
    covers: ["P4.token-rate"],
    requires: [...GET_STATE],
  },
  {
    kind: "status",
    id: "P7.status-input-tokens",
    owner: "P7",
    title: "Input tokens",
    covers: ["P4.token-in"],
    requires: [...SESSION_STATS],
  },
  {
    kind: "status",
    id: "P7.status-output-tokens",
    owner: "P7",
    title: "Output tokens",
    covers: ["P4.token-out"],
    requires: [...SESSION_STATS],
  },
  {
    kind: "status",
    id: "P7.status-total-tokens",
    owner: "P7",
    title: "Total tokens",
    covers: ["P4.token-total"],
    requires: [...SESSION_STATS],
  },
  {
    kind: "status",
    id: "P7.status-cache-hit",
    owner: "P7",
    title: "Cache hit rate",
    covers: ["P4.cache-hit"],
    requires: [...SESSION_STATS],
  },
  {
    kind: "status",
    id: "P7.status-cache-read",
    owner: "P7",
    title: "Cache read tokens",
    covers: ["P4.cache-read"],
    requires: [...SESSION_STATS],
  },
  {
    kind: "status",
    id: "P7.status-cache-write",
    owner: "P7",
    title: "Cache write tokens",
    covers: ["P4.cache-write"],
    requires: [...SESSION_STATS],
  },
  {
    kind: "status",
    id: "P7.status-cost",
    owner: "P7",
    title: "Session cost",
    covers: ["P4.cost"],
    requires: [...SESSION_STATS],
  },
  {
    kind: "status",
    id: "P7.status-last-turn",
    owner: "P7",
    title: "Last turn usage",
    covers: ["P4.per-turn-usage-row"],
    requires: [],
  },
  {
    kind: "status",
    id: "P7.status-provider-limits",
    owner: "P7",
    title: "Provider limits",
    covers: ["P4.usage-status-segment"],
    requires: ["host.usage-limits"],
  },
] as const satisfies readonly StatusDescriptor[];

export const P7_MESSAGE_DESCRIPTORS = [
  {
    kind: "message",
    id: "P7.message-compaction-summary",
    owner: "P7",
    title: "Compaction summary",
    covers: ["P4.compaction-summary-divider"],
    requires: [],
    match: { by: "role", role: "compactionSummary" },
  },
] as const satisfies readonly MessageDescriptor[];

export const P7_NOTICE_DESCRIPTORS = [
  {
    kind: "notice",
    id: "P7.notice-cache-miss",
    owner: "P7",
    title: "Cache went cold",
    covers: ["P4.cache-miss-divider"],
    requires: [],
    severity: "info",
  },
  {
    kind: "notice",
    id: "P7.notice-auto-compaction",
    owner: "P7",
    title: "Automatic compaction progress and result",
    covers: ["P4.auto-compaction-progress-result"],
    requires: [],
    severity: "info",
  },
] as const satisfies readonly NoticeDescriptor[];

/**
 * One C0 setting descriptor per S4 Context section, as S1 does for its sections: the section's
 * first control names the descriptor's key, and the section's own `inventory` row is its cover.
 */
function contextSettingDescriptor(section: SettingsSectionDescriptor): SettingDescriptor {
  const representative = section.controls[0];
  if (!representative) throw new Error(`P7 setting section ${section.id} has no controls.`);
  return {
    kind: "setting",
    id: section.id,
    owner: "P7",
    title: `Context / ${section.title} settings`,
    covers: [...section.inventory],
    requires: [...section.requires],
    key: representative.key,
    section: section.section,
  };
}

export const P7_SETTING_DESCRIPTORS: readonly SettingDescriptor[] =
  P7_CONTEXT_SETTINGS_SECTIONS.map(contextSettingDescriptor);

/** Every P7 registry descriptor: the commands, the settings sections, and the status, message and notice rows. */
export const P7_DESCRIPTORS: readonly Descriptor[] = [
  ...P7_COMMAND_DESCRIPTORS,
  ...P7_SETTING_DESCRIPTORS,
  ...P7_STATUS_DESCRIPTORS,
  ...P7_MESSAGE_DESCRIPTORS,
  ...P7_NOTICE_DESCRIPTORS,
];
