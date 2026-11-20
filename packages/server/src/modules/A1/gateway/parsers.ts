import type { OmpCommandGatewayService } from "./gateway";
import { registerMemoryParser } from "./memory-parsers";
import { registerModeChangeParsers } from "./mode-parsers";
import { parseSessionDeleteReply } from "./session-delete-parser";
import { registerToolsParser } from "./tools-parsers";

/**
 * Registers typed parsers for every command family whose output has a stable omp-owned shape. (`/share` and `/dump`,
 * which export a whole session with its system prompt, had parsers for a page that no longer exists; they went on
 * 2026-11-20: a person who wants one types the command in a chat, where omp runs it as its own.)
 */
export function registerOmpCommandParsers(gateway: OmpCommandGatewayService): void {
  registerModeChangeParsers(gateway);
  gateway.registerCommandParser("session", parseSessionDeleteReply);
  registerToolsParser(gateway);
  registerMemoryParser(gateway);
}
