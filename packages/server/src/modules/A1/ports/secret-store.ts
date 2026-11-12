import { SecretStore } from "@omp-app/contracts";
import type { PortRegistration } from "../../../registry/ports";
import type { A1PortContext } from "./context";
import { assertNotAborted, createA1PortRegistration } from "./helper";

/** omp's secrets for Hide Secrets; every change of the file or of the setting goes to every page as `changed`. */
export function createSecretStoreRegistration(context: A1PortContext): PortRegistration {
  const store = context.secretStore;
  return createA1PortRegistration(
    SecretStore,
    {
      list: async (_args, handlerContext) => {
        assertNotAborted(handlerContext);
        return store.list();
      },
      add: async (args, handlerContext) => {
        assertNotAborted(handlerContext);
        return store.add(args);
      },
      remove: async (args, handlerContext) => {
        assertNotAborted(handlerContext);
        await store.remove(args);
        return null;
      },
      reveal: async (args, handlerContext) => {
        assertNotAborted(handlerContext);
        const revealed = await store.reveal(args);
        // Which secret went to which connection, never its value: a page that copies or shows one is on record.
        context.logger?.info("secret.revealed", {
          name: args.name,
          connection: handlerContext.connectionId,
        });
        return revealed;
      },
    },
    context.publish,
    [{ event: "changed", subscribe: (listener) => store.subscribe(listener) }],
    context.watchStreamActivity,
  );
}
