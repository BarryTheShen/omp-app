/**
 * omp's Hide Secrets placeholder, a chat AI's stand-in for a saved secret: `$$`, the secret's name in capitals and
 * digits, `_`, a code, a hint of the value's case, `$$` (`$$AMOJWTSECRET_2XUBD7NWOZ1U:L$$`); a secret saved without a
 * name has the code alone. The transcript's Markdown draws one as a lock and the name (`secretPlaceholders.ts` in the
 * vendored transcript, which keeps its own copy of this pattern).
 */
const PLACEHOLDER = /\$\$(?:([A-Z0-9]+)_)?[A-Z0-9]{8,}(?::[ULCM])?\$\$/g;
const AT_START = new RegExp(`^${PLACEHOLDER.source}`);

/** Whether the text starts with a secret's placeholder, which is a word of a message, never Python's `$$`. */
export function startsWithSecretPlaceholder(text: string): boolean {
  return AT_START.test(text);
}

/** The text with each secret's placeholder written as a lock and the secret's name, for a title or a line. */
export function withSecretNames(text: string): string {
  return text.replace(
    PLACEHOLDER,
    (_placeholder, name: string | undefined) => `🔒 ${name ?? "secret"}`,
  );
}
