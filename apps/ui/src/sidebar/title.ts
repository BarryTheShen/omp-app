import type { SessionFile } from "@omp-app/contracts";

/** A chat's name as the list shows it: the name it was given, else its first message. */
export const titleOf = (session: SessionFile): string =>
  session.displayTitle ?? session.title ?? session.firstPrompt ?? "Untitled chat";
