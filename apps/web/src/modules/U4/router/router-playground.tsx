import type { CapabilityMap, ThreadId } from "@omp-app/contracts";
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Button } from "@/components/ui/button";
import { OverlayHost, useOverlayHost } from "@/overlay";
import type { HostRequestAnswerAdapter } from "../contract/host-answers";
import { renderDialogRequest } from "../dialogs";
import { DialogHostController } from "../host";
import { ExtensionUiRequestRouterController } from "./router";

const capabilities: CapabilityMap = { "omp.ui": { state: "available", via: "rpc" } };
const threadId = "u4-5-playground" as ThreadId;

const noHostAnswers: HostRequestAnswerAdapter = {
  submit: async () => {},
  cancel: async () => {},
};

function RouterPlayground() {
  const overlay = useOverlayHost();
  const hostRef = useRef<DialogHostController | null>(null);
  const routerRef = useRef<ExtensionUiRequestRouterController | null>(null);
  const [status, setStatus] = useState("No OAuth request yet");
  if (hostRef.current === null) {
    hostRef.current = new DialogHostController({
      overlay,
      capabilities,
      answerExtensionUi: async () => {},
      render: renderDialogRequest,
    });
    routerRef.current = new ExtensionUiRequestRouterController({
      dialogHost: hostRef.current,
      overlay,
      hostAnswers: noHostAnswers,
    });
  }
  const host = hostRef.current;
  const router = routerRef.current;
  if (!router) throw new Error("Router is missing.");
  useEffect(() => () => host.dispose(), [host]);

  useEffect(() => {
    if (!new URLSearchParams(window.location.search).has("presentation")) return;
    void router.routeExtensionUi(
      {
        request: {
          type: "extension_ui_request",
          id: "router-presentation",
          method: "notify",
          message: "OAuth handoff presented",
        },
        receivedSeq: 2,
      },
      { threadId },
    );
  }, [router]);

  const openOAuth = () => {
    void router
      .routeExtensionUi(
        {
          request: {
            type: "extension_ui_request",
            id: "router-oauth",
            method: "open_url",
            url: "https://accounts.example/authorize?token=ephemeral",
            launchUrl: "https://localhost/callback",
            instructions: "Continue in the provider window, then return here.",
          },
          receivedSeq: 1,
        },
        { threadId },
      )
      .then(() => setStatus("OAuth handoff presented"));
  };

  return (
    <main className="min-h-screen bg-background text-foreground" data-testid="u4-5-playground">
      <header className="border-border bg-card flex items-center justify-between border-b px-6 py-4">
        <div>
          <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
            omp / U4
          </p>
          <h1 className="text-xl font-semibold">Safe URL router playground</h1>
        </div>
        <p className="text-muted-foreground text-xs" data-testid="router-status">
          {status}
        </p>
      </header>
      <section className="mx-auto flex min-h-[70vh] w-full max-w-3xl flex-col justify-center gap-5 px-6 py-12">
        <div className="border-border bg-card rounded-xl border p-6 shadow-sm">
          <p className="text-muted-foreground text-sm">OAuth handoff</p>
          <p className="mt-2 text-base">
            The full authorization URL remains ephemeral; the prompt shows only its destination
            host.
          </p>
        </div>
        <Button id="open-oauth" type="button" onClick={openOAuth}>
          Continue sign-in
        </Button>
      </section>
    </main>
  );
}

const root = document.getElementById("u4-5-playground-root");
if (!root) throw new Error("U4.5 playground root is missing.");
createRoot(root).render(
  <OverlayHost>
    <RouterPlayground />
  </OverlayHost>,
);
