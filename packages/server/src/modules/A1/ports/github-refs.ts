import { GithubRefsPort } from "@omp-app/contracts";
import type { PortRegistration } from "../../../registry/ports";
import type { GithubRefsService } from "../github-refs";
import type { A1PortContext } from "./context";
import { createA1PortRegistration } from "./helper";

export function createGithubRefsRegistration(
  githubRefs: GithubRefsService,
  context: Pick<A1PortContext, "publish" | "watchStreamActivity">,
): PortRegistration {
  return createA1PortRegistration(
    GithubRefsPort,
    {
      search: (args, handlerContext) => githubRefs.search(args, handlerContext.signal),
      currentPullRequest: (args, handlerContext) =>
        githubRefs.currentPullRequest(args, handlerContext.signal),
    },
    context.publish,
  );
}
