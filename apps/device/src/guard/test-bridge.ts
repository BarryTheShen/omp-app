/**
 * For the guard's tests only: ssh's ProxyCommand into the guard, as the person's agent bridges a stream. Asks the guard
 * to `open` a stream on its control socket, then passes ssh's bytes both ways.
 * usage: bun test-bridge.ts <control socket> <stream>
 */
export {};

const [socketPath = "", streamText = "1"] = process.argv.slice(2);
let answered = false;
let head = "";
const socket = await Bun.connect({
  unix: socketPath,
  socket: {
    data(_socket, chunk) {
      if (answered) {
        process.stdout.write(chunk);
        return;
      }
      head += new TextDecoder().decode(chunk);
      const newline = head.indexOf("\n");
      if (newline === -1) return;
      const line = head.slice(0, newline);
      if (line !== "ok") {
        process.stderr.write(`${line}\n`);
        process.exit(255);
      }
      answered = true;
      const rest = head.slice(newline + 1);
      if (rest !== "") process.stdout.write(rest);
      void (async () => {
        for await (const bytes of Bun.stdin.stream()) socket.write(bytes);
      })();
    },
    close() {
      process.exit(0);
    },
  },
});
socket.write(`${JSON.stringify({ op: "open", stream: Number(streamText) })}\n`);
