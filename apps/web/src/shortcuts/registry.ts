import type {
  CapabilityKey,
  Descriptor,
  DescriptorId,
  ShortcutDescriptor,
} from "@omp-app/contracts";
import { normalizeChord } from "@omp-app/contracts";

export type ShortcutScope = "global" | "composer" | "transcript" | "dialog" | `panel:${string}`;
export type ShortcutAction = () => void | Promise<void>;

/**
 * Browser/OS-owned chords are not reliably delivered to page JavaScript and must not be offered as
 * app actions. `Mod` means Ctrl on Windows/Linux and Cmd on macOS. Sources:
 * Chrome: https://support.google.com/chrome/answer/157179?hl=en&co=GENIE.Platform%3DDesktop
 * Edge: https://support.microsoft.com/en-us/edge/keyboard-shortcuts-in-microsoft-edge
 * Firefox: https://support.mozilla.org/en-US/kb/keyboard-shortcuts-perform-firefox-tasks-quickly
 */
export const BROWSER_RESERVED_CHORDS = Object.freeze([
  "Mod+T",
  "Mod+N",
  "Mod+W",
  "Mod+Shift+T",
  "Mod+Shift+N",
  "Mod+Tab",
  "Mod+L",
  "Mod+Q",
  "Mod+J",
]);

/**
 * Focus navigation: keyboard users move through the page with these, so no page-level default may
 * take them. Editor scopes (`*-input`) handle Tab inside their own field (completion), so only they
 * may use them.
 */
export const FOCUS_NAVIGATION_CHORDS = Object.freeze(["Tab", "Shift+Tab"]);

export interface PreferenceStore {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
  delete(key: string): void;
}

export class MemoryPreferenceStore implements PreferenceStore {
  private readonly values = new Map<string, string>();

  public get(key: string): string | undefined {
    return this.values.get(key);
  }

  public set(key: string, value: string): void {
    this.values.set(key, value);
  }

  public delete(key: string): void {
    this.values.delete(key);
  }
}

export interface ShortcutBinding {
  readonly id: DescriptorId;
  readonly owner: ShortcutDescriptor["owner"];
  readonly title: string;
  readonly scope: string;
  readonly defaultChord: string;
  readonly chord: string;
  readonly normalizedChord: string;
  readonly requires: readonly CapabilityKey[];
}

export interface ShortcutConflict {
  readonly scope: string;
  readonly normalizedChord: string;
  readonly first: ShortcutBinding;
  readonly second: ShortcutBinding;
}
export interface ShortcutRegistryProblem {
  readonly kind: "reserved-chord";
  readonly id: DescriptorId;
  readonly chord: string;
  readonly detail: string;
}

export interface RebindResult {
  readonly ok: boolean;
  readonly binding?: ShortcutBinding;
  readonly conflicts: readonly ShortcutConflict[];
  readonly error?: string;
}

export interface DispatchResult {
  readonly handled: boolean;
  readonly binding?: ShortcutBinding;
}

export interface ShortcutError {
  readonly binding: ShortcutBinding;
  readonly error: unknown;
}

export interface ShortcutPreferenceError {
  readonly error: unknown;
}

export interface ShortcutRegistryOptions {
  readonly preferenceStore?: PreferenceStore;
  readonly preferenceKey?: string;
}

export const SHORTCUT_PREFERENCES_KEY = "omp.app.shortcuts";

function isEditableTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      target.tagName === "INPUT" ||
      target.tagName === "TEXTAREA" ||
      target.tagName === "SELECT")
  );
}

/** Whether the target sits inside the element that names this focus scope with `data-focus-scope`. */
function inFocusScope(target: EventTarget | null, scope: string): boolean {
  return target instanceof Element && target.closest(`[data-focus-scope="${scope}"]`) !== null;
}

function keyName(event: KeyboardEvent): string {
  if (event.key === " ") return "Space";
  if (event.key === "Escape") return "Esc";
  if (event.key.length === 1) return event.key.toUpperCase();
  return event.key;
}

function eventChord(event: KeyboardEvent): string {
  const modifiers: string[] = [];
  if (event.ctrlKey || event.metaKey) modifiers.push("Mod");
  if (event.altKey) modifiers.push("Alt");
  if (event.shiftKey) modifiers.push("Shift");
  return [...modifiers, keyName(event)].join("+");
}

/** App-only opt-ins: `allowInEditable` acts while a text box has focus; `focus` limits a chord to the element that carries that `data-focus-scope`. */
type RegisteredShortcutDescriptor = ShortcutDescriptor & {
  readonly allowInEditable?: true;
  readonly focus?: string;
};

function shortcutDescriptors(
  descriptors: readonly Descriptor[],
): readonly RegisteredShortcutDescriptor[] {
  return descriptors.filter(
    (descriptor): descriptor is RegisteredShortcutDescriptor => descriptor.kind === "shortcut",
  );
}

function bindingFor(descriptor: ShortcutDescriptor, chord: string): ShortcutBinding {
  return {
    id: descriptor.id,
    owner: descriptor.owner,
    title: descriptor.title,
    scope: descriptor.scope,
    defaultChord: descriptor.chord,
    chord,
    normalizedChord: normalizeChord(chord),
    requires: descriptor.requires,
  };
}
function isReservedChord(chord: string, scope: string): boolean {
  const normalized = normalizeChord(chord);
  const matches = (reserved: string) => normalizeChord(reserved) === normalized;
  if (BROWSER_RESERVED_CHORDS.some(matches)) return true;
  return !scope.endsWith("-input") && FOCUS_NAVIGATION_CHORDS.some(matches);
}

function reservedMessage(chord: string): string {
  const normalized = normalizeChord(chord);
  return FOCUS_NAVIGATION_CHORDS.some((reserved) => normalizeChord(reserved) === normalized)
    ? `${chord.trim()} moves keyboard focus in the browser`
    : `Your browser keeps ${chord.trim()} for itself`;
}

interface ParsedOverrides {
  readonly overrides: Readonly<Record<string, string>>;
  readonly error?: unknown;
}

function parseOverrides(raw: string | undefined): ParsedOverrides {
  if (raw === undefined) return { overrides: {} };
  try {
    const value: unknown = JSON.parse(raw);
    if (value === null || typeof value !== "object" || Array.isArray(value))
      return { overrides: {}, error: new Error("Shortcut preferences must be a JSON object.") };
    const output: Record<string, string> = {};
    for (const [id, chord] of Object.entries(value)) {
      if (typeof chord !== "string" || chord.trim().length === 0)
        return { overrides: {}, error: new Error(`Invalid shortcut preference for ${id}.`) };
      output[id] = chord;
    }
    return { overrides: output };
  } catch (error: unknown) {
    return { overrides: {}, error };
  }
}

/** What a palette command runs. See `ShortcutRegistry.registerCommand`. */
export interface CommandAction {
  readonly run: ShortcutAction;
  readonly shortcut?: DescriptorId;
}

/** C0 shortcut descriptors plus app-owned overrides, actions, dispatch, and conflict checks. */
export class ShortcutRegistry {
  private readonly descriptors: ReadonlyMap<DescriptorId, RegisteredShortcutDescriptor>;
  private readonly store: PreferenceStore;
  private readonly preferenceKey: string;
  private readonly overrides: Map<string, string>;
  private readonly actions = new Map<DescriptorId, ShortcutAction>();
  private readonly commands = new Map<DescriptorId, CommandAction>();
  private readonly listeners = new Set<() => void>();
  private errorSnapshot: ShortcutError | undefined;
  private preferenceErrorSnapshot: ShortcutPreferenceError | undefined;
  private bindingSnapshot: readonly ShortcutBinding[] = [];

  public constructor(descriptors: readonly Descriptor[], options: ShortcutRegistryOptions = {}) {
    this.descriptors = new Map(
      shortcutDescriptors(descriptors).map((descriptor) => [descriptor.id, descriptor]),
    );
    this.store = options.preferenceStore ?? new MemoryPreferenceStore();
    this.preferenceKey = options.preferenceKey ?? SHORTCUT_PREFERENCES_KEY;
    let raw: string | undefined;
    let readError: unknown;
    try {
      raw = this.store.get(this.preferenceKey);
    } catch (error: unknown) {
      readError = error;
    }
    const parsed =
      readError === undefined ? parseOverrides(raw) : { overrides: {}, error: readError };
    this.overrides = new Map(Object.entries(parsed.overrides));
    this.preferenceErrorSnapshot = parsed.error === undefined ? undefined : { error: parsed.error };
    this.bindingSnapshot = this.computeBindings();
  }

  public subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public bindings(): readonly ShortcutBinding[] {
    return this.bindingSnapshot;
  }
  public lastError(): ShortcutError | undefined {
    return this.errorSnapshot;
  }

  public clearError(): void {
    if (this.errorSnapshot === undefined) return;
    this.errorSnapshot = undefined;
    this.notify();
  }
  public preferenceError(): ShortcutPreferenceError | undefined {
    return this.preferenceErrorSnapshot;
  }
  public isBrowserReserved(chord: string, scope = "global"): boolean {
    return isReservedChord(chord, scope);
  }

  public problems(): readonly ShortcutRegistryProblem[] {
    return this.bindings()
      .filter((binding) => isReservedChord(binding.defaultChord, binding.scope))
      .map((binding) => ({
        kind: "reserved-chord",
        id: binding.id,
        chord: binding.defaultChord,
        detail: reservedMessage(binding.defaultChord),
      }));
  }

  private computeBindings(): readonly ShortcutBinding[] {
    return [...this.descriptors.values()].map((descriptor) =>
      bindingFor(descriptor, this.overrides.get(descriptor.id) ?? descriptor.chord),
    );
  }

  public conflicts(bindings = this.bindings()): readonly ShortcutConflict[] {
    const conflicts: ShortcutConflict[] = [];
    const seen = new Map<string, ShortcutBinding>();
    for (const binding of bindings) {
      const key = `${binding.scope}\u0000${binding.normalizedChord}`;
      const first = seen.get(key);
      if (first !== undefined) {
        conflicts.push({
          scope: binding.scope,
          normalizedChord: binding.normalizedChord,
          first,
          second: binding,
        });
      } else {
        seen.set(key, binding);
      }
    }
    return conflicts;
  }

  public registerAction(id: DescriptorId, action: ShortcutAction): () => void {
    this.actions.set(id, action);
    return () => {
      if (this.actions.get(id) === action) this.actions.delete(id);
    };
  }

  /**
   * A palette command a mounted feature can run. `shortcut` names the shortcut that runs the same
   * action; the palette shows that shortcut's current chord beside the command.
   */
  public registerCommand(id: DescriptorId, command: CommandAction): () => void {
    this.commands.set(id, command);
    return () => {
      if (this.commands.get(id) === command) this.commands.delete(id);
    };
  }

  public commandFor(id: DescriptorId): CommandAction | undefined {
    return this.commands.get(id);
  }

  public dispatch(event: KeyboardEvent, scope: string): DispatchResult {
    if (event.defaultPrevented || event.isComposing) {
      return { handled: false };
    }
    const normalized = normalizeChord(eventChord(event));
    const matching = this.bindings().filter(
      (candidate) =>
        candidate.scope === scope &&
        candidate.normalizedChord === normalized &&
        !isReservedChord(candidate.chord, candidate.scope),
    );
    if (matching.length !== 1) return { handled: false };
    const binding = matching[0];
    if (binding === undefined) return { handled: false };
    if (
      isEditableTarget(event.target) &&
      this.descriptors.get(binding.id)?.allowInEditable !== true
    )
      return { handled: false };
    const focusScope = this.descriptors.get(binding.id)?.focus;
    if (focusScope !== undefined && !inFocusScope(event.target, focusScope))
      return { handled: false };
    const action = this.actions.get(binding.id);
    if (action === undefined) return { handled: false, binding };
    event.preventDefault();
    this.clearError();
    try {
      const pending = action();
      if (pending !== undefined)
        void Promise.resolve(pending).catch((error: unknown) => this.reportError(error, binding));
    } catch (error: unknown) {
      this.reportError(error, binding);
    }
    return { handled: true, binding };
  }

  public rebind(id: DescriptorId, chord: string): RebindResult {
    const descriptor = this.descriptors.get(id);
    if (descriptor === undefined || chord.trim().length === 0) {
      return { ok: false, conflicts: [] };
    }
    if (isReservedChord(chord, descriptor.scope)) {
      return { ok: false, conflicts: [], error: reservedMessage(chord) };
    }
    const candidate = bindingFor(descriptor, chord);
    const next = this.bindings().map((binding) => (binding.id === id ? candidate : binding));
    const conflicts = this.conflicts(next).filter(
      (conflict) => conflict.first.id === id || conflict.second.id === id,
    );
    if (conflicts.length > 0) return { ok: false, conflicts };
    this.overrides.set(id, chord);
    this.persist();
    this.preferenceErrorSnapshot = undefined;
    this.bindingSnapshot = this.computeBindings();
    this.notify();
    return { ok: true, binding: candidate, conflicts: [] };
  }

  public reset(id: DescriptorId): void {
    if (!this.overrides.delete(id)) return;
    this.persist();
    this.preferenceErrorSnapshot = undefined;
    this.bindingSnapshot = this.computeBindings();
    this.notify();
  }

  public resetAll(): void {
    if (this.overrides.size === 0 && this.preferenceErrorSnapshot === undefined) return;
    this.overrides.clear();
    this.persist();
    this.preferenceErrorSnapshot = undefined;
    this.bindingSnapshot = this.computeBindings();
    this.notify();
  }
  private reportError(error: unknown, binding: ShortcutBinding): void {
    this.errorSnapshot = { binding, error };
    this.notify();
  }
  private persist(): void {
    if (this.overrides.size === 0) {
      this.store.delete(this.preferenceKey);
      return;
    }
    this.store.set(this.preferenceKey, JSON.stringify(Object.fromEntries(this.overrides)));
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }
}
