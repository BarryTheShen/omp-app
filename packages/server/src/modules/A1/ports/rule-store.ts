import { RuleStore } from "@omp-app/contracts";
import type { PortRegistration } from "../../../registry/ports";
import type { RuleChangeListener, RuleStoreService } from "../rules";
import type { A1PortContext } from "./context";
import { assertNotAborted, createA1PortRegistration } from "./helper";

function decodeScope(
  scope: string,
): { scope: "global"; folder: null } | { scope: "project"; folder: string } | null {
  if (scope === "global") return { scope: "global", folder: null };
  if (scope.startsWith("folder:") && scope.length > "folder:".length) {
    return { scope: "project", folder: scope.slice("folder:".length) };
  }
  return null;
}

export function createRuleStoreRegistration(
  ruleStore: RuleStoreService,
  context: Pick<A1PortContext, "publish" | "watchStreamActivity">,
): PortRegistration {
  const bindings = [
    {
      event: "changed",
      subscribeScoped: (scope: string, listener: (payload: unknown) => void) => {
        const decoded = decodeScope(scope);
        return decoded
          ? ruleStore.subscribe(decoded, listener as RuleChangeListener)
          : () => undefined;
      },
    },
  ];
  return createA1PortRegistration(
    RuleStore,
    {
      list: async (args, handlerContext) => {
        assertNotAborted(handlerContext);
        return ruleStore.list(args);
      },
      read: async (args, handlerContext) => {
        assertNotAborted(handlerContext);
        return ruleStore.read(args);
      },
      write: async (args, handlerContext) => {
        assertNotAborted(handlerContext);
        return ruleStore.write(args);
      },
      delete: async (args, handlerContext) => {
        assertNotAborted(handlerContext);
        return ruleStore.delete(args);
      },
    },
    context.publish,
    bindings,
    context.watchStreamActivity,
  );
}
