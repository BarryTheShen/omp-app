import type { AppClient } from "@omp-app/client";
import { type SpeechRecording, SpeechToTextPort } from "@omp-app/contracts";
import { Copy, CornerDownLeft, Paperclip, Pause, Play, RotateCcw, Trash2 } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { follow } from "../follow";

function when(startedAt: number): string {
  return new Date(startedAt).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function length(recording: SpeechRecording): string {
  const seconds = Math.round(recording.pieces.reduce((sum, piece) => sum + piece.ms, 0) / 1000);
  return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}

/** The kept recordings, newest first, kept current by the server's events. */
function useRecordings(client: AppClient, open: boolean): readonly SpeechRecording[] {
  const [recordings, setRecordings] = useState<readonly SpeechRecording[]>([]);
  useEffect(() => {
    if (!open) return;
    let active = true;
    const port = client.port(SpeechToTextPort);
    port.list({}).then(
      (result) => active && setRecordings(result.recordings),
      () => undefined,
    );
    const stops = [
      follow(client.subscribe(SpeechToTextPort, "recording"), (recording) =>
        setRecordings((before) =>
          before.some((each) => each.id === recording.id)
            ? before.map((each) => (each.id === recording.id ? recording : each))
            : [recording, ...before],
        ),
      ),
      follow(client.subscribe(SpeechToTextPort, "removed"), ({ recordingId }) =>
        setRecordings((before) => before.filter((each) => each.id !== recordingId)),
      ),
    ];
    return () => {
      active = false;
      for (const stop of stops) stop();
    };
  }, [client, open]);
  return recordings;
}

/** Plays a recording's pieces one after another, fetched from the server a chunk at a time. */
function usePlayer(client: AppClient): {
  playing: string | null;
  play: (recording: SpeechRecording) => void;
  stop: () => void;
} {
  const [playing, setPlaying] = useState<string | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const run = useRef(0);
  const stop = (): void => {
    run.current += 1;
    audio.current?.pause();
    audio.current = null;
    setPlaying(null);
  };
  // Leaving the dialog stops the sound.
  useEffect(
    () => () => {
      run.current += 1;
      audio.current?.pause();
    },
    [],
  );
  const play = (recording: SpeechRecording): void => {
    stop();
    const mine = ++run.current;
    setPlaying(recording.id);
    const port = client.port(SpeechToTextPort);
    void (async () => {
      for (const piece of recording.pieces) {
        const parts: Uint8Array<ArrayBuffer>[] = [];
        let offset = 0;
        for (;;) {
          const chunk = await port.audio({ recordingId: recording.id, index: piece.index, offset });
          const bytes = Uint8Array.from(atob(chunk.data), (char) => char.charCodeAt(0));
          parts.push(bytes);
          offset += bytes.length;
          if (bytes.length === 0 || offset >= chunk.size) break;
        }
        if (run.current !== mine) return;
        const url = URL.createObjectURL(new Blob(parts, { type: "audio/wav" }));
        const element = new Audio(url);
        audio.current = element;
        await new Promise<void>((resolve) => {
          element.onended = () => resolve();
          element.onerror = () => resolve();
          void element.play().catch(() => resolve());
        });
        URL.revokeObjectURL(url);
        if (run.current !== mine) return;
      }
      if (run.current === mine) setPlaying(null);
    })().catch(() => {
      if (run.current === mine) setPlaying(null);
    });
  };
  return { playing, play, stop };
}

/** A recording's whole audio (`audio.wav`, on the server once every part is in) as a file, fetched a chunk at a time. */
async function wholeAudio(client: AppClient, recording: SpeechRecording): Promise<File> {
  const port = client.port(SpeechToTextPort);
  const parts: Uint8Array<ArrayBuffer>[] = [];
  let offset = 0;
  for (;;) {
    const chunk = await port.audio({ recordingId: recording.id, offset });
    const bytes = Uint8Array.from(atob(chunk.data), (char) => char.charCodeAt(0));
    parts.push(bytes);
    offset += bytes.length;
    if (bytes.length === 0 || offset >= chunk.size) break;
  }
  const stamp = new Date(recording.startedAt).toISOString().slice(0, 16).replace(/[:T]/g, "-");
  return new File(parts, `recording-${stamp}.wav`, { type: "audio/wav" });
}

/**
 * Recent recordings (V259): what voice input kept, newest first, for the kept days. Each shows its text (pieces still
 * being written, and failed ones with Retry), and can go into the box, have its audio attached to the message (for the
 * agent to listen to, cut or transcribe again), be copied, played or deleted. A recording cancelled, or found
 * unfinished after a reload, is here; nothing said is lost while it is kept. On the server each one is a folder
 * (`<app data>/voice/<id>/`) with `audio.wav` and `transcript.md`.
 */
export function RecentRecordings({
  client,
  open,
  onOpenChange,
  onInsert,
  onAttach,
}: {
  readonly client: AppClient;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Puts a recording's text into the message box; without it (Settings) only Copy is offered. */
  readonly onInsert?: (text: string) => void;
  /** Attaches a recording's audio to the message, as the paperclip attaches a file. */
  readonly onAttach?: (file: File) => void;
}): ReactNode {
  const [attaching, setAttaching] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const recordings = useRecordings(client, open);
  const player = usePlayer(client);
  const [deleting, setDeleting] = useState<string | null>(null);
  const port = client.port(SpeechToTextPort);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) player.stop();
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Recent recordings</DialogTitle>
          <DialogDescription>
            What you said, kept on the server with its audio. A part that couldn't be transcribed
            keeps its audio for Retry.
          </DialogDescription>
        </DialogHeader>
        {problem !== null && (
          <p role="alert" className="text-xs text-bad-ink">
            {problem}
          </p>
        )}
        {recordings.length === 0 ? (
          <p className="py-6 text-center text-sm text-t3">No recordings yet.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {recordings.map((recording) => {
              const failed = recording.pieces.filter((piece) => piece.state === "failed");
              const writing = recording.pieces.filter(
                (piece) => piece.state === "stored" || piece.state === "transcribing",
              ).length;
              return (
                <li key={recording.id} className="rounded-lg border border-l2 p-3">
                  <div className="flex items-center gap-2 text-xs text-t3">
                    <span>{when(recording.startedAt)}</span>
                    <span>·</span>
                    <span>{length(recording)}</span>
                    {writing > 0 && <span>· writing out {writing}…</span>}
                    {failed.length > 0 && (
                      <span className="text-bad-ink">
                        · {failed.length} {failed.length === 1 ? "part" : "parts"} not transcribed
                      </span>
                    )}
                  </div>
                  <p className="mt-1.5 text-sm break-words whitespace-pre-wrap text-t1">
                    {recording.text === "" ? (
                      <span className="text-t3">No text yet.</span>
                    ) : (
                      recording.text
                    )}
                  </p>
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    {onInsert !== undefined && (
                      <Button
                        type="button"
                        size="sm"
                        variant="default"
                        disabled={recording.text === ""}
                        onClick={() => {
                          onInsert(recording.text);
                          onOpenChange(false);
                        }}
                      >
                        <CornerDownLeft /> Insert
                      </Button>
                    )}
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={recording.text === ""}
                      onClick={() => void navigator.clipboard.writeText(recording.text)}
                    >
                      <Copy /> Copy
                    </Button>
                    {onAttach !== undefined && (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        // The whole recording's audio is written once every part is in.
                        disabled={
                          attaching !== null ||
                          recording.pieceCount === undefined ||
                          recording.pieces.some(
                            (piece) => piece.state === "stored" || piece.state === "transcribing",
                          )
                        }
                        title="Attach the recording's audio to the message, for the AI to use"
                        onClick={() => {
                          setAttaching(recording.id);
                          setProblem(null);
                          void wholeAudio(client, recording)
                            .then((file) => {
                              onAttach(file);
                              onOpenChange(false);
                            })
                            .catch((failure: unknown) =>
                              setProblem(
                                `The audio could not be attached: ${failure instanceof Error ? failure.message : String(failure)}`,
                              ),
                            )
                            .finally(() => setAttaching(null));
                        }}
                      >
                        <Paperclip /> {attaching === recording.id ? "Attaching…" : "Attach audio"}
                      </Button>
                    )}
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        player.playing === recording.id ? player.stop() : player.play(recording)
                      }
                    >
                      {player.playing === recording.id ? <Pause /> : <Play />}
                      {player.playing === recording.id ? "Stop" : "Play"}
                    </Button>
                    {failed.length > 0 && (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          for (const piece of failed)
                            void port.retry({ recordingId: recording.id, index: piece.index });
                        }}
                      >
                        <RotateCcw /> Retry
                      </Button>
                    )}
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="ml-auto text-t3 hover:text-bad-ink"
                      onClick={() => {
                        if (deleting !== recording.id) {
                          setDeleting(recording.id);
                          return;
                        }
                        setDeleting(null);
                        void port.discard({ recordingId: recording.id });
                      }}
                    >
                      <Trash2 /> {deleting === recording.id ? "Delete it?" : "Delete"}
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}
