/** The longest share link the import accepts: the same bound as the `/share` result's URL. */
const MAX_LINK_LENGTH = 2_048;

export type ShareLinkCheck =
  | { readonly ok: true; readonly link: string; readonly host: string }
  | { readonly ok: false; readonly why: "empty-link" | "bad-link" };

/**
 * Checks the link the person pasted before anything else happens: one https link on one line. The check is only
 * about what the person typed; whether omp can import it is decided by A1.12, which may still refuse it.
 */
export function checkShareLink(raw: string): ShareLinkCheck {
  const link = raw.trim();
  if (link === "") return { ok: false, why: "empty-link" };
  if (link.length > MAX_LINK_LENGTH || /\s/.test(link)) return { ok: false, why: "bad-link" };
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return { ok: false, why: "bad-link" };
  }
  if (url.protocol !== "https:" || url.hostname === "") return { ok: false, why: "bad-link" };
  return { ok: true, link, host: url.host };
}
