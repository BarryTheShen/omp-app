import type { AppClient } from "@omp-app/client";
import { PushPort } from "@omp-app/contracts";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { setGroupTools, useGroupTools } from "../chat/groupTools";
import { currentSubscription, enablePush, needsHomeScreen, pushSupported } from "../push/push";
import { loadSettingsData, type SettingDef } from "../settings/data";
import { useConfig } from "../settings/useConfig";
import { setStyle, useStyle } from "../theme/style";
import { setThemeMode, type ThemeMode, useThemeMode } from "../theme/theme";
import { setCloseAfter, useCloseAfter } from "../workspace/closeIdle";
import {
  type Answers,
  type Change,
  type Current,
  OMP_KEYS,
  type Plan,
  planFor,
  type SettingValue,
} from "./plan";
import { readProposal } from "./proposal";
import { answerOf, QUESTIONS } from "./questions";
import { applyChanges, type Setters } from "./record";

/** Every folder's omp settings: the setup changes omp for every chat, not one folder's. */
const GLOBAL = { layer: "global", folder: null } as const;

const SETTING_NAMES: Readonly<Record<string, string>> = {
  themeMode: "Light or dark",
  style: "Style",
  groupTools: "Group tool calls",
  closeAfter: "Close workspaces not used for",
  defaultThinkingLevel: "omp: thinking level",
  "tools.approvalMode": "omp: ask before acting",
  "todo.eager": "omp: create to-dos by itself",
  "task.autoParallel": "omp: split work across agents",
  "retry.waitForUsageReset": "omp: wait out usage limits",
};

const VALUE_WORDS: Readonly<Record<string, string>> = {
  "always-ask": "before every action",
  write: "before changing files",
  yolo: "never (just work)",
  system: "match the system",
  light: "light",
  dark: "dark",
  suggest: "suggest",
  off: "off",
  default: "omp's default",
};

function words(setting: string, value: SettingValue): string {
  if (value === null) return setting === "closeAfter" ? "never" : "not set";
  if (typeof value === "boolean") return value ? "on" : "off";
  if (setting === "closeAfter") return value === 24 ? "1 day" : `${value} hours`;
  return VALUE_WORDS[String(value)] ?? String(value);
}

const nameOf = (change: Change): string =>
  change.where === "browser" ? change.setting : change.key;

/**
 * Set up omp-app: a few questions about how the app will be used, then one plan of every setting that would change
 * (now → after), and only on Apply the changes, kept so Settings → App → Undo setup can put them back (`record.ts`).
 * Every question can be skipped; a skipped one changes nothing.
 */
export function SetupDialog({
  client,
  open,
  proposal,
  onOpenChange,
  onSignIn,
  onFineTune,
}: {
  readonly client: AppClient;
  readonly open: boolean;
  /** A chat's proposal block (`proposal.ts`): the setup opens on its plan of changes instead of the questions. */
  readonly proposal: string | null;
  readonly onOpenChange: (open: boolean) => void;
  /** Opens the providers' sign-in (Settings → Providers). */
  readonly onSignIn: () => void;
  /** Starts the AI round: a new chat where omp asks more and proposes omp settings (`interviewPrompt`). */
  readonly onFineTune: () => void;
}): ReactNode {
  const [step, setStep] = useState(0);
  const [picks, setPicks] = useState<Readonly<Record<string, readonly string[]>>>({});
  const [phase, setPhase] = useState<"questions" | "plan" | "done">("questions");
  const [skipped, setSkipped] = useState<ReadonlySet<string>>(new Set());
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notifying, setNotifying] = useState(false);
  const [made, setMade] = useState<readonly Change[]>([]);
  const config = useConfig(client, GLOBAL);
  const themeMode = useThemeMode();
  const style = useStyle();
  const groupTools = useGroupTools();
  const closeAfter = useCloseAfter();
  /** omp's settings as its own page lists them: names a chat's proposal and checks its values. */
  const [defs, setDefs] = useState<readonly SettingDef[]>([]);

  useEffect(() => {
    if (!open) return;
    void currentSubscription().then((subscription) => setNotifying(subscription !== null));
    void loadSettingsData().then((data) => setDefs(data.settings));
  }, [open]);
  // A proposal opens on its plan.
  useEffect(() => {
    if (open && proposal !== null) setPhase("plan");
  }, [open, proposal]);

  const answers = useMemo<Answers>(() => {
    const out: Record<string, unknown> = {};
    for (const question of QUESTIONS) {
      const picked = picks[question.id];
      if (picked === undefined || picked.length === 0) continue;
      out[question.id] = answerOf(question, picked);
    }
    return out as Answers;
  }, [picks]);

  const current = useMemo<Current>(
    () => ({
      browser: { themeMode, style, groupTools, closeAfter },
      omp: new Map(
        OMP_KEYS.flatMap((key) => {
          const entry = config.entries.get(key);
          return entry === undefined || entry.secret
            ? []
            : [[key, { value: entry.value as SettingValue, theirs: entry.source !== "default" }]];
        }),
      ),
      notifying,
    }),
    [themeMode, style, groupTools, closeAfter, config.entries, notifying],
  );
  /** A chat's proposal as changes from the values in force; what it named wrongly, left out with why. */
  const proposed = useMemo(() => {
    if (proposal === null) return null;
    const read = readProposal(proposal, defs);
    const changes: Change[] = read.proposed.flatMap((each) => {
      const entry = config.entries.get(each.key);
      const from = entry === undefined || entry.secret ? null : (entry.value as SettingValue);
      return from === each.value
        ? []
        : [
            {
              where: "omp" as const,
              key: each.key,
              from,
              to: each.value,
              theirs: entry !== undefined && entry.source !== "default",
              ...(each.why === "" ? {} : { why: each.why }),
            },
          ];
    });
    return { plan: { changes, steps: [] } satisfies Plan, left: read.left };
  }, [proposal, defs, config.entries]);
  const plan: Plan = useMemo(
    () => proposed?.plan ?? planFor(answers, current),
    [proposed, answers, current],
  );
  const label = (name: string): string =>
    SETTING_NAMES[name] ??
    `omp: ${defs.find((def) => def.key === name)?.label.toLowerCase() ?? name}`;
  // A change of a value the person set themselves starts unticked: the setup keeps what they chose unless they tick it.
  useEffect(() => {
    setSkipped(
      new Set(
        plan.changes
          .filter((change) => change.where === "omp" && change.theirs)
          .map((change) => nameOf(change)),
      ),
    );
  }, [plan]);

  const setters: Setters = {
    browser: (setting, value) => {
      if (setting === "themeMode") setThemeMode(value as ThemeMode);
      else if (setting === "style") setStyle(String(value));
      else if (setting === "groupTools") setGroupTools(value === true);
      else setCloseAfter(value === null ? null : Number(value));
    },
    omp: (key, value) => config.write(key, value === "unset" ? "unset" : { secret: false, value }),
  };

  const reset = (): void => {
    setStep(0);
    setPicks({});
    setPhase("questions");
    setProblem(null);
    setMade([]);
  };
  const close = (next: boolean): void => {
    onOpenChange(next);
    if (!next) reset();
  };

  const apply = async (): Promise<void> => {
    setBusy(true);
    setProblem(null);
    try {
      const chosen = plan.changes.filter((change) => !skipped.has(nameOf(change)));
      const record = await applyChanges(chosen, setters);
      setMade(record.changes);
      setPhase("done");
    } catch (failure) {
      setProblem(
        `Some settings could not be changed: ${failure instanceof Error ? failure.message : String(failure)}. What was changed can be undone in Settings → App.`,
      );
    } finally {
      setBusy(false);
    }
  };

  const turnOnNotifications = async (): Promise<void> => {
    setBusy(true);
    setProblem(null);
    try {
      await enablePush(client);
      await client.port(PushPort).test({});
      setNotifying(true);
    } catch (failure) {
      setProblem(
        `Notifications did not turn on: ${failure instanceof Error ? failure.message : String(failure)}`,
      );
    } finally {
      setBusy(false);
    }
  };

  const question = QUESTIONS[step];
  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        {phase === "questions" && question !== undefined && (
          <>
            <DialogHeader>
              <p className="text-xs text-t3">
                Set up omp-app · {step + 1} of {QUESTIONS.length}
              </p>
              <DialogTitle>{question.title}</DialogTitle>
              {question.detail !== undefined && (
                <DialogDescription>{question.detail}</DialogDescription>
              )}
            </DialogHeader>
            <Choices
              question={question}
              picked={picks[question.id] ?? []}
              onPick={(picked) => setPicks((now) => ({ ...now, [question.id]: picked }))}
            />
            <div className="flex items-center gap-2 pt-2">
              <Button
                variant="ghost"
                size="sm"
                disabled={step === 0}
                onClick={() => setStep(step - 1)}
              >
                Back
              </Button>
              <span className="flex-1" />
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setPicks((now) => ({ ...now, [question.id]: [] }));
                  if (step + 1 < QUESTIONS.length) setStep(step + 1);
                  else setPhase("plan");
                }}
              >
                Skip
              </Button>
              <Button
                size="sm"
                disabled={(picks[question.id] ?? []).length === 0}
                onClick={() => (step + 1 < QUESTIONS.length ? setStep(step + 1) : setPhase("plan"))}
              >
                Next
              </Button>
            </div>
          </>
        )}
        {phase === "plan" && (
          <>
            <DialogHeader>
              <DialogTitle>{proposal === null ? "Your setup" : "omp's proposal"}</DialogTitle>
              <DialogDescription>
                {plan.changes.length === 0
                  ? proposal === null
                    ? "Nothing to change: the settings already match your answers."
                    : "Nothing to change: the settings already are as proposed."
                  : "These settings change when you press Apply. Untick any to keep it as it is. Settings → App → Undo setup puts them all back."}
              </DialogDescription>
            </DialogHeader>
            {plan.changes.length > 0 && (
              <ul aria-label="Changes" className="flex flex-col gap-2">
                {plan.changes.map((change) => {
                  const name = nameOf(change);
                  return (
                    <li key={name}>
                      {/* biome-ignore lint/a11y/noLabelWithoutControl: the square mark inside is the control */}
                      <label className="flex items-start gap-2.5">
                        <Checkbox
                          className="mt-0.5"
                          checked={!skipped.has(name)}
                          onCheckedChange={(on) =>
                            setSkipped((now) => {
                              const next = new Set(now);
                              if (on === true) next.delete(name);
                              else next.add(name);
                              return next;
                            })
                          }
                        />
                        <span className="text-sm text-t1">
                          {label(name)}: {words(name, change.from)} → {words(name, change.to)}
                          {change.where === "omp" && change.why !== undefined && (
                            <span className="block text-xs text-t2">{change.why}</span>
                          )}
                          {change.where === "omp" && change.theirs && (
                            <span className="block text-xs text-t3">You set this yourself.</span>
                          )}
                          {change.where === "browser" && (
                            <span className="block text-xs text-t3">In this browser.</span>
                          )}
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}
            {proposed !== null && proposed.left.length > 0 && (
              <div className="text-xs text-t3">
                <p>Left out:</p>
                <ul aria-label="Left out" className="list-disc pl-4">
                  {proposed.left.map((why) => (
                    <li key={why}>{why}</li>
                  ))}
                </ul>
              </div>
            )}
            {problem !== null && (
              <p role="alert" className="text-xs text-bad-ink [overflow-wrap:anywhere]">
                {problem}
              </p>
            )}
            <div className="flex items-center gap-2 pt-2">
              {proposal === null && (
                <Button variant="ghost" size="sm" onClick={() => setPhase("questions")}>
                  Change answers
                </Button>
              )}
              <span className="flex-1" />
              <Button variant="ghost" size="sm" onClick={() => close(false)}>
                Cancel
              </Button>
              <Button size="sm" disabled={busy || !config.loaded} onClick={() => void apply()}>
                Apply
              </Button>
            </div>
          </>
        )}
        {phase === "done" && (
          <>
            <DialogHeader>
              <DialogTitle>omp-app is set up</DialogTitle>
              <DialogDescription>
                {made.length === 0
                  ? "No settings changed."
                  : `${made.length} ${made.length === 1 ? "setting" : "settings"} changed. Settings → App → Undo setup puts them back.`}
              </DialogDescription>
            </DialogHeader>
            <ul aria-label="Next steps" className="flex flex-col gap-3 text-sm text-t1">
              {plan.steps.includes("notifications") && !notifying && (
                <li className="flex items-center gap-3">
                  <span className="flex-1">
                    {pushSupported()
                      ? "Turn on notifications here; a test one follows."
                      : needsHomeScreen()
                        ? "On an iPhone or iPad, add the app to the Home Screen first (Share → Add to Home Screen), then turn notifications on in Settings → App."
                        : "This browser cannot show notifications."}
                  </span>
                  {pushSupported() && (
                    <Button size="sm" disabled={busy} onClick={() => void turnOnNotifications()}>
                      Turn on notifications
                    </Button>
                  )}
                </li>
              )}
              {plan.steps.includes("notifications") && notifying && (
                <li>Notifications are on here; a test one is on its way.</li>
              )}
              {plan.steps.includes("notifications-elsewhere") && (
                <li>
                  On your other devices, open the app and turn on Settings → App → Notifications
                  there.
                </li>
              )}
              {plan.steps.includes("sign-in") && (
                <li className="flex items-center gap-3">
                  <span className="flex-1">
                    If you have not yet, sign in to a model provider: Settings → Providers.
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      close(false);
                      onSignIn();
                    }}
                  >
                    Open Settings
                  </Button>
                </li>
              )}
              {proposal === null && (
                <li className="flex items-center gap-3">
                  <span className="flex-1">
                    Fine-tune with omp: a new chat where omp asks a few more questions and proposes
                    omp settings, which you review here before anything changes.
                  </span>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      close(false);
                      onFineTune();
                    }}
                  >
                    Fine-tune with omp
                  </Button>
                </li>
              )}
            </ul>
            {problem !== null && (
              <p role="alert" className="text-xs text-bad-ink [overflow-wrap:anywhere]">
                {problem}
              </p>
            )}
            <div className="flex justify-end pt-2">
              <Button size="sm" onClick={() => close(false)}>
                Done
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** One question's choices: round marks for one, square ones for several. */
function Choices({
  question,
  picked,
  onPick,
}: {
  readonly question: (typeof QUESTIONS)[number];
  readonly picked: readonly string[];
  readonly onPick: (picked: readonly string[]) => void;
}): ReactNode {
  const row = (label: string, detail: string | undefined): ReactNode => (
    <span className="text-sm text-t1">
      {label}
      {detail !== undefined && <span className="block text-xs text-t3">{detail}</span>}
    </span>
  );
  if (question.multi)
    return (
      <fieldset aria-label={question.title} className="flex flex-col gap-2.5">
        {question.options.map((option) => (
          // biome-ignore lint/a11y/noLabelWithoutControl: the square mark inside is the control
          <label key={option.value} className="flex items-start gap-2.5">
            <Checkbox
              className="mt-0.5"
              checked={picked.includes(option.value)}
              onCheckedChange={(on) =>
                onPick(
                  on === true
                    ? [...picked, option.value]
                    : picked.filter((value) => value !== option.value),
                )
              }
            />
            {row(option.label, option.detail)}
          </label>
        ))}
      </fieldset>
    );
  return (
    <RadioGroup
      aria-label={question.title}
      value={picked[0] ?? null}
      onValueChange={(value) => {
        if (typeof value === "string") onPick([value]);
      }}
    >
      {question.options.map((option) => (
        // biome-ignore lint/a11y/noLabelWithoutControl: the round mark inside is the control
        <label key={option.value} className="flex items-start gap-2.5">
          <RadioGroupItem className="mt-0.5" value={option.value} />
          {row(option.label, option.detail)}
        </label>
      ))}
    </RadioGroup>
  );
}
