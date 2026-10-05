import { ProviderAccountStore } from "@omp-app/contracts";
import type { PortRegistration } from "../../../registry/ports";
import type { A1PortContext } from "./context";
import { assertNotAborted, createA1PortRegistration } from "./helper";

export function createProviderAccountStoreRegistration(context: A1PortContext): PortRegistration {
  return createA1PortRegistration(
    ProviderAccountStore,
    {
      listProviders: async (_args, handlerContext) => {
        assertNotAborted(handlerContext);
        return context.providerAccountStore.listProviders();
      },
      listAccounts: async (args, handlerContext) => {
        assertNotAborted(handlerContext);
        return context.providerAccountStore.listAccounts(args);
      },
      logout: async (args, handlerContext) => {
        assertNotAborted(handlerContext);
        return context.providerAccountStore.logout(args);
      },
      pin: async (args, handlerContext) => {
        assertNotAborted(handlerContext);
        return context.providerAccountStore.pin(args);
      },
      resetUsage: async (args, handlerContext) => {
        assertNotAborted(handlerContext);
        return context.providerAccountStore.resetUsage(args);
      },
    },
    context.publish,
  );
}
