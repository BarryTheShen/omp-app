import { ThreadId } from "@omp-app/contracts";

/**
 * The chat the address names (`#chat=<id>`: the lite view's "Open in the full app", #2843), taken out of the address so
 * a reload shows the workspace as it is by then; null when it names none, or not a chat's id.
 */
export function takeLinkChat(): ThreadId | null {
  const params = new URLSearchParams(window.location.hash.slice(1));
  const linked = params.get("chat");
  if (linked === null) return null;
  params.delete("chat");
  const rest = params.toString();
  window.history.replaceState(
    null,
    "",
    `${window.location.pathname}${window.location.search}${rest.length > 0 ? `#${rest}` : ""}`,
  );
  const parsed = ThreadId.safeParse(linked);
  return parsed.success ? parsed.data : null;
}
