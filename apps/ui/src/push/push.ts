import type { AppClient } from "@omp-app/client";
import { PushPort, ThreadId } from "@omp-app/contracts";
import { useEffect } from "react";

/**
 * The app's own notifications on this device (Web Push, `public/sw.js`). Pushes need a secure page, a service worker and
 * the Push API: an iPhone has them only in the Home Screen app (iOS 16.4 and later), not in Safari's tabs; the desktop
 * window's WebKitGTK has none (it raises its own notifications, `desktop/notify.ts`).
 */
export function pushSupported(): boolean {
  return (
    window.isSecureContext &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

/** On an iPhone or iPad outside the Home Screen app, where pushes need the app on the Home Screen first. */
export function needsHomeScreen(): boolean {
  const apple = /iPhone|iPad/.test(navigator.userAgent);
  const standalone =
    (navigator as Navigator & { standalone?: boolean }).standalone === true ||
    matchMedia("(display-mode: standalone)").matches;
  return apple && !standalone;
}

/** The service worker, registered once the page has loaded (it handles only pushes). */
export function registerWorker(): void {
  if (!pushSupported()) return;
  const register = (): void => {
    void navigator.serviceWorker.register("/sw.js").catch(() => undefined);
  };
  if (document.readyState === "complete") register();
  else window.addEventListener("load", register, { once: true });
}

/** What this device is called in Settings' list. */
export function deviceName(): string {
  const agent = navigator.userAgent;
  if (/iPhone/.test(agent)) return "iPhone";
  if (/iPad/.test(agent)) return "iPad";
  if (/Android/.test(agent)) return "Android";
  const browser = /Edg\//.test(agent)
    ? "Edge"
    : /Firefox\//.test(agent)
      ? "Firefox"
      : /Chrome\//.test(agent)
        ? "Chrome"
        : /Safari\//.test(agent)
          ? "Safari"
          : "Browser";
  const system = /Mac OS X/.test(agent)
    ? "Mac"
    : /Windows/.test(agent)
      ? "Windows"
      : /Linux/.test(agent)
        ? "Linux"
        : "";
  return system === "" ? browser : `${browser} on ${system}`;
}

/** This device's subscription, if it has one. */
export async function currentSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  const registration = await navigator.serviceWorker.getRegistration("/");
  return (await registration?.pushManager.getSubscription()) ?? null;
}

/**
 * Turns this device's notifications on: called straight from the tap (the system asks only then), it asks for the
 * permission, subscribes with the server's key and hands the server the subscription.
 */
export async function enablePush(client: AppClient): Promise<void> {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    throw new Error(
      permission === "denied"
        ? "Notifications are off for this app in the system's settings."
        : "Notifications were not allowed.",
    );
  }
  const registration = await navigator.serviceWorker.register("/sw.js");
  await navigator.serviceWorker.ready;
  const { publicKey } = await client.port(PushPort).key({});
  const subscription =
    (await registration.pushManager.getSubscription()) ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: Uint8Array.from(
        atob(publicKey.replaceAll("-", "+").replaceAll("_", "/")),
        (char) => char.charCodeAt(0),
      ),
    }));
  const json = subscription.toJSON();
  await client.port(PushPort).subscribe({
    endpoint: subscription.endpoint,
    keys: { p256dh: json.keys?.p256dh ?? "", auth: json.keys?.auth ?? "" },
    device: deviceName(),
  });
}

/** Turns this device's notifications off: the server forgets it and the subscription ends. */
export async function disablePush(client: AppClient): Promise<void> {
  const subscription = await currentSubscription();
  if (subscription === null) return;
  await client.port(PushPort).unsubscribe({ endpoint: subscription.endpoint });
  await subscription.unsubscribe();
}

/** A notification tapped while the app is open: the worker asks the page to open the chat it names. */
export function useNotificationOpens(open: (chat: ThreadId) => void): void {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const onMessage = (event: MessageEvent): void => {
      const data = event.data as { type?: unknown; chat?: unknown } | null;
      if (data?.type !== "omp-app:open-chat") return;
      const chat = ThreadId.safeParse(data.chat);
      if (chat.success) open(chat.data);
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  }, [open]);
}
