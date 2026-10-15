/**
 * What may never reach the debug log. The log is meant to be attached to bug reports, so the code
 * that writes to it never passes prompts, file contents, tokens or keys; this is the second wall:
 * every line is scrubbed on its way out, so a secret that sneaks into an error message or a child
 * process's stderr line is replaced instead of saved.
 */

const REDACTED = "[redacted]";

/** Keys whose value is secret by their name, in `key=value`, `key: value` and JSON forms. */
const SECRET_KEY_VALUE =
  /\b(token|access[_-]?token|api[_-]?key|apikey|secret|password|passwd|authorization|cookie)(["']?\s*[=:]\s*["']?)([^\s"',;&}]{6,})/gi;

/** A bearer token, `Bearer <token>`, after an `Authorization:` header or alone. It runs before the key-value
 * rule, which would take the word `Bearer` after `Authorization:` as the secret and leave the token behind. */
const BEARER_TOKEN = /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi;

/** The credentials of a Basic authorization header, `Authorization: Basic <token>`, and its proxy form. The token is the
 * base64 of `user:password`, so the whole token goes, and the user name with it. It runs before the key-value rule,
 * which needs six characters after the key and so leaves the token behind when the scheme `Basic` is the value. */
const BASIC_CREDENTIALS = /\b((?:Proxy-)?Authorization["']?\s*[=:]\s*["']?Basic\s+)[^\s"',;&}]+/gi;

/** The password in `scheme://user:password@host`, as git prints remote URLs. The user and the host stay, so the
 * line still says where it failed. It runs before the key-value rule. */
const URL_PASSWORD = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)[^\s/@]+(?=@)/gi;

const SECRET_PATTERNS: readonly RegExp[] = [
  // Provider and service keys: OpenAI/Anthropic (sk-...), GitHub, Google, Slack, AWS.
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  // The launch link's fragment: `#token=...`.
  /#token=[^\s&"']+/gi,
  // Anything that looks like a long random secret: 32+ characters mixing lower case, upper case and
  // digits. Hex digests, git hashes, UUIDs and paths do not match.
  /\b(?=[A-Za-z0-9_-]*[a-z])(?=[A-Za-z0-9_-]*[A-Z])(?=[A-Za-z0-9_-]*[0-9])[A-Za-z0-9_-]{32,}\b/g,
];

/** Replaces secrets in `text`; `known` are exact secret values (for example this launch's token). */
export function scrubText(text: string, known: readonly string[] = []): string {
  let result = text;
  for (const secret of known) {
    if (secret.length >= 6) result = result.split(secret).join(REDACTED);
  }
  result = result.replace(BEARER_TOKEN, REDACTED);
  result = result.replace(BASIC_CREDENTIALS, `$1${REDACTED}`);
  result = result.replace(URL_PASSWORD, `$1${REDACTED}`);
  result = result.replace(SECRET_KEY_VALUE, `$1$2${REDACTED}`);
  for (const pattern of SECRET_PATTERNS) result = result.replace(pattern, REDACTED);
  return result;
}

/** Cuts `text` to `max` characters and says how much was cut. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…(+${text.length - max} chars)`;
}
