import type { AppClient } from "@omp-app/client";
import {
  AppFailure,
  type PortCallOptions,
  type PortClient,
  type Rule,
  type RuleChanged,
  type RuleDeleteArgs,
  type RuleDeleteResult,
  type RuleListArgs,
  type RuleListResult,
  RuleName as RuleNameSchema,
  type RuleReadArgs,
  type RuleScope,
  RuleStore,
  type RuleWriteArgs,
  type RuleWriteResult,
} from "@omp-app/contracts";

type RulePortClient = PortClient<typeof RuleStore>;
type RuleCallOptions = Pick<PortCallOptions, "signal">;

export interface RuleScopeSelection {
  readonly scope: RuleScope;
  readonly folder: RuleListArgs["folder"];
}

export interface RuleStoreAdapter {
  readonly list: (args: RuleListArgs, options?: RuleCallOptions) => Promise<RuleListResult>;
  readonly read: (args: RuleReadArgs, options?: RuleCallOptions) => Promise<Rule>;
  readonly write: (args: RuleWriteArgs, options?: RuleCallOptions) => Promise<RuleWriteResult>;
  readonly delete: (args: RuleDeleteArgs, options?: RuleCallOptions) => Promise<RuleDeleteResult>;
  readonly subscribeChanged: (
    scope: RuleScopeSelection,
    listener: (change: RuleChanged) => void,
  ) => () => void;
}

function invalidArgs(message: string): AppFailure {
  return new AppFailure({ code: "invalid_args", message, retryable: false });
}

function ruleName(value: string): RuleReadArgs["id"] {
  const parsed = RuleNameSchema.safeParse(value);
  if (!parsed.success) throw invalidArgs("The rule name is invalid.");
  return parsed.data;
}

function scopeKey(scope: RuleScopeSelection): string {
  return scope.scope === "global" ? "global" : `folder:${scope.folder}`;
}

function subscribeScoped(
  client: AppClient,
  scope: string,
  listener: (change: RuleChanged) => void,
): () => void {
  let active = true;
  let removeListener: (() => void) | undefined;
  let subscription:
    | {
        readonly onEvent: (listener: (payload: RuleChanged) => void) => () => void;
        readonly unsubscribe: () => Promise<void>;
      }
    | undefined;
  const pending = client
    .subscribe(RuleStore, "changed", { scope })
    .then((next) => {
      subscription = next;
      if (!active) {
        void next.unsubscribe();
        return;
      }
      removeListener = next.onEvent((payload) => listener(payload));
    })
    .catch(() => undefined);
  return () => {
    active = false;
    removeListener?.();
    void pending.then(() => subscription?.unsubscribe()).catch(() => undefined);
  };
}

/** Adapts A0.8's typed AppClient to the browser RuleStore seam; CAS stays server-authoritative. */
export function createRuleStoreAdapter(client: AppClient): RuleStoreAdapter {
  const port: RulePortClient = client.port(RuleStore);
  return {
    list: (args, options) => port.list(args, options),
    read: async (args, options) => port.read({ ...args, id: ruleName(args.id) }, options),
    write: async (args, options) => port.write({ ...args, id: ruleName(args.id) }, options),
    delete: async (args, options) => port.delete({ ...args, id: ruleName(args.id) }, options),
    subscribeChanged: (scope, listener) => subscribeScoped(client, scopeKey(scope), listener),
  };
}
