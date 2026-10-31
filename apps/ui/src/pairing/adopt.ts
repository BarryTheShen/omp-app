import type { AppClient } from "@omp-app/client";
import { DevicesPort } from "@omp-app/contracts";
import { forgetToken } from "../connection";
import type { DeviceGuess } from "./device-name";
import { adoptPage } from "./pairing-api";

/** A page on the app's own computer: it keeps the launch link's token, as `omp-app` itself does, and is no device. */
function onThisComputer(): boolean {
  const host = window.location.hostname;
  return host === "127.0.0.1" || host === "localhost";
}

/**
 * A page signed in with the launch link from another device becomes a paired device once: the server makes it one with
 * the guessed name, its key comes as a cookie, and the page forgets the token, so removing the device in Settings
 * sticks. A page that is a device already only forgets the token. Pages on this computer keep it; a server from before
 * pairing, or a refusal, changes nothing.
 */
export async function adoptThisPage(
  client: AppClient,
  token: string,
  guess: DeviceGuess,
): Promise<void> {
  if (onThisComputer()) return;
  let thisDeviceId: string | null;
  try {
    thisDeviceId = (await client.port(DevicesPort).list({})).thisDeviceId;
  } catch {
    return;
  }
  if (thisDeviceId === null) {
    const adopted = await adoptPage(token, guess.name, guess.kind);
    if (!adopted.ok) return;
  }
  forgetToken();
}
