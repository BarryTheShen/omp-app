import type { McpConfigServer, McpServerConfig } from "@omp-app/contracts";
import { Plus, X } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  configOf,
  emptyForm,
  formFromJson,
  formOf,
  type McpForm,
  type McpKind,
  type McpPair,
  type McpScope,
} from "./mcpForm";

/** A finger's 44 pt on a phone or tablet. */
const TOUCH = "max-sm:h-11 tablet:h-11";
/** A field: a finger's size on touch, and no tint in dark, under which its placeholder fell to 4.0:1. */
const FIELD = `dark:bg-transparent ${TOUCH}`;
const ROW = "flex min-h-9 items-center gap-2 text-sm text-t1 max-sm:min-h-11 tablet:min-h-11";

const words = (failure: unknown): string =>
  failure instanceof Error ? failure.message : String(failure);

export interface McpSave {
  readonly name: string;
  /** The server's name before the edit; null for a new one. */
  readonly previousName: string | null;
  readonly scope: McpScope;
  readonly config: McpServerConfig;
}

/** A labelled field: its label above it, a hint under it. */
function Field({
  label,
  hint,
  children,
}: {
  readonly label: string;
  readonly hint?: string;
  readonly children: (id: string) => ReactNode;
}): ReactNode {
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-xs text-t3">
        {label}
      </label>
      {children(id)}
      {hint !== undefined && <p className="text-xs text-pretty text-t3">{hint}</p>}
    </div>
  );
}

/** Environment variables or headers: a name and a hidden value a row; a saved value stays unless typed over. */
function Pairs({
  what,
  pairs,
  onChange,
}: {
  readonly what: "Variable" | "Header";
  readonly pairs: readonly McpPair[];
  readonly onChange: (next: readonly McpPair[]) => void;
}): ReactNode {
  const set = (index: number, change: Partial<McpPair>): void =>
    onChange(pairs.map((pair, at) => (at === index ? { ...pair, ...change } : pair)));
  return (
    <div className="flex flex-col gap-1.5">
      {pairs.map((pair, index) => {
        const kept = pair.savedKey !== null && pair.key === pair.savedKey;
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity of their own; a name can be typed over
          <div key={index} className="flex items-center gap-1.5">
            <Input
              aria-label={`${what} ${index + 1} name`}
              className={`min-w-0 flex-[3] font-mono text-xs ${FIELD}`}
              placeholder="NAME"
              autoComplete="off"
              spellCheck={false}
              value={pair.key}
              onChange={(event) => set(index, { key: event.target.value })}
            />
            <Input
              aria-label={`${what} ${index + 1} value`}
              type="password"
              className={`min-w-0 flex-[2] font-mono text-xs ${FIELD}`}
              placeholder={kept ? "Saved; type to replace" : "Value"}
              autoComplete="off"
              value={pair.value}
              onChange={(event) => set(index, { value: event.target.value })}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="shrink-0 text-t3 max-sm:size-11 tablet:size-11"
              aria-label={`Remove ${what.toLowerCase()} ${pair.key.trim() === "" ? index + 1 : pair.key.trim()}`}
              onClick={() => onChange(pairs.filter((_, at) => at !== index))}
            >
              <X />
            </Button>
          </div>
        );
      })}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className={`self-start text-t2 ${TOUCH}`}
        onClick={() => onChange([...pairs, { key: "", value: "", savedKey: null }])}
      >
        <Plus />
        {what === "Variable" ? "Add a variable" : "Add a header"}
      </Button>
    </div>
  );
}

/**
 * Add an MCP server, or edit one (#16): its name, where omp keeps it, how omp reaches it (a local command with its
 * arguments, variables and folder, or an address with its headers) and its timeout; or JSON as MCP pages publish it,
 * which fills the form. Saved values never reach the page: a variable or header saved before shows "Saved", and keeps
 * its value unless one is typed. Mounted afresh for each opening (the caller's `key`).
 */
export function McpServerEditor({
  open,
  onOpenChange,
  editing,
  scope,
  hasFolder,
  onSave,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** The server edited; null to add one. */
  readonly editing: McpConfigServer | null;
  /** Where a new server goes unless changed. */
  readonly scope: McpScope;
  /** A folder is open, so a server can be kept for it alone. */
  readonly hasFolder: boolean;
  /** Writes it; a failure's message is shown here. */
  readonly onSave: (save: McpSave) => Promise<void>;
}): ReactNode {
  const [form, setForm] = useState<McpForm>(() =>
    editing === null ? emptyForm(scope) : formOf(editing),
  );
  const [view, setView] = useState<"form" | "json">("form");
  const [json, setJson] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const change = (next: Partial<McpForm>): void => setForm((shown) => ({ ...shown, ...next }));

  const fill = (): void => {
    const read = formFromJson(json, form.scope);
    if ("problem" in read) {
      setProblem(read.problem);
      return;
    }
    // An edited server keeps its name and its on or off unless the JSON gives them.
    setForm({
      ...read.form,
      name: read.form.name === "" ? form.name : read.form.name,
      enabled: read.form.enabled ?? form.enabled,
    });
    setNote(read.note);
    setProblem(null);
    setView("form");
  };

  const save = async (): Promise<void> => {
    const made = configOf(form);
    if ("problem" in made) {
      setProblem(made.problem);
      return;
    }
    setSaving(true);
    setProblem(null);
    try {
      await onSave({
        name: made.name,
        previousName: editing?.name ?? null,
        scope: editing?.scope ?? form.scope,
        config: made.config,
      });
      onOpenChange(false);
    } catch (failure) {
      setProblem(words(failure));
    } finally {
      setSaving(false);
    }
  };

  const kept = editing?.scope ?? form.scope;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[min(90dvh,52rem)] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {editing === null ? "Add an MCP server" : `Edit ${editing.name}`}
          </DialogTitle>
          <DialogDescription className="text-pretty">
            {kept === "user"
              ? "Kept in your MCP file: every chat in every folder can use it."
              : "Kept in this folder's MCP file: only chats in this folder use it."}
          </DialogDescription>
        </DialogHeader>
        <ToggleGroup
          aria-label="Fill it in"
          size="sm"
          spacing={0.5}
          className="self-start rounded-lg border border-l2 p-0.5"
          value={[view]}
          onValueChange={(next: string[]) => {
            if (next[0] === "form" || next[0] === "json") setView(next[0]);
          }}
        >
          <ToggleGroupItem
            value="form"
            className={`h-7 px-2.5 text-xs text-t3 aria-pressed:bg-l2 aria-pressed:text-t1 ${TOUCH}`}
          >
            Form
          </ToggleGroupItem>
          <ToggleGroupItem
            value="json"
            className={`h-7 px-2.5 text-xs text-t3 aria-pressed:bg-l2 aria-pressed:text-t1 ${TOUCH}`}
          >
            JSON
          </ToggleGroupItem>
        </ToggleGroup>

        {view === "json" ? (
          <div className="flex flex-col gap-2">
            <Field
              label="The server's JSON"
              hint={
                'As MCP pages publish it: {"mcpServers": {"name": {…}}}, VS Code\'s {"servers": …}, or one server\'s own object.'
              }
            >
              {(id) => (
                <Textarea
                  id={id}
                  rows={9}
                  spellCheck={false}
                  className="font-mono text-xs"
                  placeholder={
                    '{\n  "mcpServers": {\n    "github": {\n      "command": "npx",\n      "args": ["-y", "@modelcontextprotocol/server-github"]\n    }\n  }\n}'
                  }
                  value={json}
                  onChange={(event) => setJson(event.target.value)}
                />
              )}
            </Field>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className={`self-start ${TOUCH}`}
              disabled={json.trim() === ""}
              onClick={fill}
            >
              Fill the form
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <Field label="Name" hint="Letters, digits, '.', ':', '-', '_' and single spaces.">
              {(id) => (
                <Input
                  id={id}
                  className={FIELD}
                  autoComplete="off"
                  spellCheck={false}
                  value={form.name}
                  onChange={(event) => change({ name: event.target.value })}
                />
              )}
            </Field>
            {editing === null && hasFolder && (
              <RadioGroup
                aria-label="Kept for"
                className="gap-0"
                value={form.scope}
                onValueChange={(next) => {
                  if (next === "user" || next === "project") change({ scope: next });
                }}
              >
                <p className="text-xs text-t3">Kept for</p>
                {/* biome-ignore lint/a11y/noLabelWithoutControl: the round mark inside is the control */}
                <label className={ROW}>
                  <RadioGroupItem value="user" aria-label="Every folder" />
                  Every folder
                </label>
                {/* biome-ignore lint/a11y/noLabelWithoutControl: the round mark inside is the control */}
                <label className={ROW}>
                  <RadioGroupItem value="project" aria-label="This folder only" />
                  This folder only
                </label>
              </RadioGroup>
            )}
            <RadioGroup
              aria-label="omp reaches it"
              className="gap-0"
              value={form.kind}
              onValueChange={(next) => {
                if (next === "stdio" || next === "http" || next === "sse")
                  change({ kind: next as McpKind });
              }}
            >
              <p className="text-xs text-t3">omp reaches it</p>
              {/* biome-ignore lint/a11y/noLabelWithoutControl: the round mark inside is the control */}
              <label className={ROW}>
                <RadioGroupItem value="stdio" aria-label="By starting a command" />
                By starting a command
              </label>
              {/* biome-ignore lint/a11y/noLabelWithoutControl: the round mark inside is the control */}
              <label className={ROW}>
                <RadioGroupItem value="http" aria-label="At an address, over HTTP" />
                At an address, over HTTP
              </label>
              {/* biome-ignore lint/a11y/noLabelWithoutControl: the round mark inside is the control */}
              <label className={ROW}>
                <RadioGroupItem value="sse" aria-label="At an address, over SSE" />
                At an address, over SSE (older servers)
              </label>
            </RadioGroup>
            {form.kind === "stdio" ? (
              <>
                <Field label="Command">
                  {(id) => (
                    <Input
                      id={id}
                      className={`font-mono text-xs ${FIELD}`}
                      placeholder="npx"
                      autoComplete="off"
                      spellCheck={false}
                      value={form.command}
                      onChange={(event) => change({ command: event.target.value })}
                    />
                  )}
                </Field>
                <Field label="Arguments" hint="One a line, as the server's page lists them.">
                  {(id) => (
                    <Textarea
                      id={id}
                      rows={3}
                      spellCheck={false}
                      className="font-mono text-xs"
                      placeholder={"-y\n@modelcontextprotocol/server-github"}
                      value={form.args}
                      onChange={(event) => change({ args: event.target.value })}
                    />
                  )}
                </Field>
                <div className="flex flex-col gap-1">
                  <p className="text-xs text-t3">Environment variables</p>
                  <Pairs what="Variable" pairs={form.env} onChange={(env) => change({ env })} />
                </div>
                <Field label="Folder it runs in" hint="Empty: the chat's folder.">
                  {(id) => (
                    <Input
                      id={id}
                      className={`font-mono text-xs ${FIELD}`}
                      autoComplete="off"
                      spellCheck={false}
                      value={form.cwd}
                      onChange={(event) => change({ cwd: event.target.value })}
                    />
                  )}
                </Field>
              </>
            ) : (
              <>
                <Field label="Address">
                  {(id) => (
                    <Input
                      id={id}
                      type="url"
                      className={`font-mono text-xs ${FIELD}`}
                      placeholder="https://mcp.example.com/mcp"
                      autoComplete="off"
                      spellCheck={false}
                      value={form.url}
                      onChange={(event) => change({ url: event.target.value })}
                    />
                  )}
                </Field>
                <div className="flex flex-col gap-1">
                  <p className="text-xs text-t3">Headers</p>
                  <Pairs
                    what="Header"
                    pairs={form.headers}
                    onChange={(headers) => change({ headers })}
                  />
                </div>
              </>
            )}
            <Field label="Timeout in seconds" hint="Empty: omp's own.">
              {(id) => (
                <Input
                  id={id}
                  inputMode="decimal"
                  className={`w-32 ${FIELD}`}
                  autoComplete="off"
                  value={form.timeout}
                  onChange={(event) => change({ timeout: event.target.value })}
                />
              )}
            </Field>
          </div>
        )}

        {note !== null && (
          <p role="status" className="text-xs text-pretty text-t2">
            {note}
          </p>
        )}
        {problem !== null && (
          <p role="alert" className="text-xs text-pretty text-bad-ink">
            {problem}
          </p>
        )}
        <DialogFooter>
          <DialogClose render={<Button type="button" variant="ghost" className={TOUCH} />}>
            Cancel
          </DialogClose>
          <Button type="button" className={TOUCH} disabled={saving} onClick={() => void save()}>
            {saving ? "Saving…" : editing === null ? "Add" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
