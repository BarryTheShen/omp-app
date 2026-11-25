import { SpeechToTextPort } from "@omp-app/contracts";
import type { PortRegistration } from "../../../registry/ports";
import type { A1PortContext } from "./context";
import { assertNotAborted, createA1PortRegistration } from "./helper";

/** Voice input (V259): its settings, and recordings sent in pieces and transcribed by the user's own server. */
export function createSpeechToTextRegistration(context: A1PortContext): PortRegistration {
  const { speechSettings: settings, speechRecordings: recordings } = context;
  return createA1PortRegistration(
    SpeechToTextPort,
    {
      settings: async (_args, handlerContext) => {
        assertNotAborted(handlerContext);
        return settings.read();
      },
      setSettings: async (args, handlerContext) => {
        assertNotAborted(handlerContext);
        return settings.set(args);
      },
      test: async (args, handlerContext) => {
        assertNotAborted(handlerContext);
        return recordings.test(args.serverId);
      },
      putPiece: async (args, handlerContext) => {
        assertNotAborted(handlerContext);
        return recordings.putPiece(args);
      },
      finish: async (args, handlerContext) => {
        assertNotAborted(handlerContext);
        return recordings.finish(args.recordingId, args.pieceCount);
      },
      retry: async (args, handlerContext) => {
        assertNotAborted(handlerContext);
        return recordings.retry(args.recordingId, args.index);
      },
      list: async (_args, handlerContext) => {
        assertNotAborted(handlerContext);
        return { recordings: [...(await recordings.list())] };
      },
      audio: async (args, handlerContext) => {
        assertNotAborted(handlerContext);
        return recordings.audio(args.recordingId, args.index, args.offset);
      },
      discard: async (args, handlerContext) => {
        assertNotAborted(handlerContext);
        await recordings.discard(args.recordingId);
        return {};
      },
    },
    context.publish,
    [
      { event: "settingsChanged", subscribe: (listener) => settings.subscribe(listener) },
      {
        event: "recording",
        subscribe: (listener) =>
          recordings.subscribe((change) => {
            if (change.kind === "recording") listener(change.recording);
          }),
      },
      {
        event: "removed",
        subscribe: (listener) =>
          recordings.subscribe((change) => {
            if (change.kind === "removed") listener({ recordingId: change.recordingId });
          }),
      },
    ],
    context.watchStreamActivity,
  );
}
