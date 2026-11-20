/**
 * The agent's local control socket (#20), `<runtime>/agent.sock`, owner-only: the desktop app's window and the
 * `omp-app-device` command talk to the running agent through it. Lines of JSON: `status`, `on`, `off`, `acknowledge`
 * answer once; `watch` streams every event. Turning on and acknowledging name the asking process, for the password
 * dialog the guard asks for it.
 */
import { chmod, rm } from "node:fs/promises";
import { z } from "zod";
import { LONGEST_ON_MINUTES } from "../guard/guard";
import type { Agent } from "./agent";

const Request = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("status") }),
  z.strictObject({
    op: z.literal("on"),
    pid: z.number().int().positive(),
    minutes: z.number().int().min(1).max(LONGEST_ON_MINUTES),
  }),
  z.strictObject({ op: z.literal("off") }),
  z.strictObject({ op: z.literal("acknowledge"), pid: z.number().int().positive() }),
  z.strictObject({
    op: z.literal("extend"),
    pid: z.number().int().positive(),
    minutes: z.number().int().min(1).max(LONGEST_ON_MINUTES),
  }),
  z.strictObject({
    op: z.literal("sudo"),
    pid: z.number().int().positive(),
    minutes: z.number().int().min(1).max(30),
  }),
  z.strictObject({
    op: z.literal("allow-folder"),
    pid: z.number().int().positive(),
    id: z.string().regex(/^[0-9a-f]{16}$/),
    write: z.boolean(),
  }),
  z.strictObject({ op: z.literal("deny-folder"), id: z.string().regex(/^[0-9a-f]{16}$/) }),
  z.strictObject({
    op: z.literal("remove-folder"),
    path: z.string().startsWith("/").max(4_096),
  }),
  /** Chats asking to reach this computer, and those allowed (PLAN §7f). */
  z.strictObject({
    op: z.literal("allow-chat"),
    pid: z.number().int().positive(),
    threadId: z.string().min(1).max(200),
  }),
  z.strictObject({ op: z.literal("deny-chat"), threadId: z.string().min(1).max(200) }),
  z.strictObject({ op: z.literal("remove-chat"), threadId: z.string().min(1).max(200) }),
  z.strictObject({ op: z.literal("watch") }),
  /** Enrolls the running agent itself, so it links at the next turn-on without a restart. */
  z.strictObject({
    op: z.literal("enroll"),
    server: z.string().min(1).max(500),
    code: z.string().min(1).max(20),
    alias: z.string().min(1).max(31),
  }),
  /** This computer is being removed: the server forgets it, and the agent's record of the link goes. */
  z.strictObject({ op: z.literal("leave") }),
]);

/** Seconds until access turns off by itself, so a window counts down on its own clock; null while off. */
function leftSeconds(state: Agent["state"]): number | null {
  return state.on ? Math.max(0, Math.round((Date.parse(state.until) - Date.now()) / 1000)) : null;
}

export function agentStatus(agent: Agent): object {
  return {
    enrolled:
      agent.machine === null
        ? null
        : { server: agent.machine.serverOrigin, alias: agent.machine.alias },
    state: agent.state,
    leftSeconds: leftSeconds(agent.state),
    linked: agent.linked,
    review: agent.review,
    folders: agent.folders,
    chats: agent.chats,
  };
}

/** Serves the control socket at `path`; returns what stops it. */
export async function serveControl(path: string, agent: Agent): Promise<() => void> {
  await rm(path, { force: true });
  const listener = Bun.listen<{ buffer: string; stop: (() => void) | null }>({
    unix: path,
    socket: {
      open(socket) {
        socket.data = { buffer: "", stop: null };
      },
      data(socket, chunk) {
        socket.data.buffer += new TextDecoder().decode(chunk);
        const at = socket.data.buffer.indexOf("\n");
        if (at === -1) {
          if (socket.data.buffer.length > 4_000) socket.end();
          return;
        }
        const line = socket.data.buffer.slice(0, at);
        socket.data.buffer = "";
        let request: z.infer<typeof Request>;
        try {
          request = Request.parse(JSON.parse(line));
        } catch {
          socket.end("error not a request\n");
          return;
        }
        const answer = (refused: string | null) =>
          socket.end(
            refused === null ? `ok ${JSON.stringify(agentStatus(agent))}\n` : `error ${refused}\n`,
          );
        switch (request.op) {
          case "status":
            answer(null);
            return;
          case "on":
            void agent.on(request.pid, request.minutes).then(answer);
            return;
          case "off":
            void agent.off().then(() => answer(null));
            return;
          case "acknowledge":
            void agent.acknowledge(request.pid).then(answer);
            return;
          case "extend":
            void agent.extend(request.pid, request.minutes).then(answer);
            return;
          case "sudo":
            void agent.sudo(request.pid, request.minutes).then(answer);
            return;
          case "allow-folder":
            void agent.allowFolder(request.pid, request.id, request.write).then(answer);
            return;
          case "deny-folder":
            void agent.denyFolder(request.id).then(answer);
            return;
          case "remove-folder":
            void agent.removeFolder(request.path).then(answer);
            return;
          case "allow-chat":
            void agent.allowChat(request.pid, request.threadId).then(answer);
            return;
          case "deny-chat":
            answer(agent.denyChat(request.threadId));
            return;
          case "remove-chat":
            void agent.removeChat(request.threadId).then(answer);
            return;
          case "enroll":
            void agent
              .enroll(request.server, request.code, request.alias)
              .catch((error: unknown) => (error instanceof Error ? error.message : String(error)))
              .then(answer);
            return;
          case "leave":
            void agent
              .leave()
              .catch((error: unknown) => (error instanceof Error ? error.message : String(error)))
              .then(answer);
            return;
          case "watch":
            socket.data.stop = agent.watch((event) =>
              socket.write(
                `${JSON.stringify(event.type === "state" ? { ...event, leftSeconds: leftSeconds(event.state) } : event)}\n`,
              ),
            );
            return;
        }
      },
      close(socket) {
        socket.data.stop?.();
      },
    },
  });
  await chmod(path, 0o600);
  return () => listener.stop(true);
}
