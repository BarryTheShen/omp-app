import { GithubRefsPort } from "@omp-app/contracts";
import type { PortRegistration } from "../../../registry/ports";
import type { A1PortContext } from "./context";
import { createA1PortRegistration } from "./helper";

export function createGithubRefsRegistration(context: A1PortContext): PortRegistration {
  return createA1PortRegistration(
    GithubRefsPort,
    {
      search: (args, handlerContext) => context.githubRefs.search(args, handlerContext.signal),
      currentPullRequest: (args, handlerContext) =>
        context.githubRefs.currentPullRequest(args, handlerContext.signal),
    },
    context.publish,
    [],
    context.watchStreamActivity,
  );
}
