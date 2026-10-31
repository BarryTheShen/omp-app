/**
 * The pairing routes, called by a page that is not paired yet (it has no connection to the app), or by a page signed in
 * with the launch link that becomes a device. A key the server gives comes back as a cookie the page never reads; the
 * next load signs in with it.
 */
import {
  type DeviceKind,
  PAIRING_PATHS,
  PairingAdopted,
  PairingAsked,
  PairingClaimed,
  PairingCodeEntered,
} from "@omp-app/contracts";

/** What a contracts schema offers that this file uses: a checked parse. */
interface Checks<T> {
  safeParse(
    value: unknown,
  ): { readonly success: true; readonly data: T } | { readonly success: false };
}

/** A route's answer, or why there is none: the server's own words when it gave them. */
export type Answer<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly message: string };

async function post<T>(
  path: string,
  body: unknown,
  schema: Checks<T>,
  headers: Record<string, string> = {},
): Promise<Answer<T>> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      credentials: "same-origin",
    });
  } catch {
    return { ok: false, message: "The app could not be reached." };
  }
  const value: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const error = (value as { error?: unknown } | undefined)?.error;
    return {
      ok: false,
      message: typeof error === "string" ? error : `The app answered ${response.status}.`,
    };
  }
  const parsed = schema.safeParse(value);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, message: "The app answered in a way this page does not know." };
}

/** Asks the paired devices to allow this one: the request's secret and the 6 digits to show. */
export function askToPair(name: string, kind: DeviceKind): Promise<Answer<PairingAsked>> {
  return post(PAIRING_PATHS.ask, { name, kind }, PairingAsked);
}

/** Makes this page, signed in with the launch link, a paired device; its key comes as a cookie. */
export function adoptPage(
  token: string,
  name: string,
  kind: DeviceKind,
): Promise<Answer<PairingAdopted>> {
  return post(PAIRING_PATHS.adopt, { name, kind }, PairingAdopted, {
    authorization: `Bearer ${token}`,
  });
}

/** Whether the request was answered; when it was allowed, the key comes as a cookie. */
export function claimPairing(requestId: string): Promise<Answer<PairingClaimed>> {
  return post(PAIRING_PATHS.claim, { requestId }, PairingClaimed);
}

/** Pairs with a one-time code; when it is right, the key comes as a cookie. */
export function enterPairingCode(
  code: string,
  name: string,
  kind: DeviceKind,
): Promise<Answer<PairingCodeEntered>> {
  return post(PAIRING_PATHS.code, { code, name, kind }, PairingCodeEntered);
}

/** The one-time code a QR code's address carries (`/#pair=K7F3QX9M`); null when it carries none. */
export function codeFromAddress(hash: string): string | null {
  const code = new URLSearchParams(hash.slice(1)).get("pair");
  return code === null || code === "" ? null : code;
}

/**
 * Takes the one-time code a QR code's address carries out of the address (its other parts stay), so a paired device
 * that scans one shows a clean address; the pairing screen gets the code from the caller.
 */
export function takePairingCode(): string | null {
  const code = codeFromAddress(window.location.hash);
  if (code === null) return null;
  const params = new URLSearchParams(window.location.hash.slice(1));
  params.delete("pair");
  const rest = params.toString();
  window.history.replaceState(
    null,
    "",
    `${window.location.pathname}${window.location.search}${rest.length > 0 ? `#${rest}` : ""}`,
  );
  return code;
}
