/**
 * The Enter that confirms a word an input method is composing (Chinese, Japanese, Korean): a field that acts on Enter
 * leaves this one to the input method, and the next Enter acts (#2820). Safari delivers the confirming Enter after the
 * composition ended, with `isComposing` false and the key code 229 (WebKit bug 165004), so both are read, as Chrome's
 * "IME-safe enter-to-submit" guide does; 229 only under the Enter check, which a phone keyboard's other keys also use.
 */
export function isImeEnter(event: {
  readonly key: string;
  readonly nativeEvent: KeyboardEvent;
}): boolean {
  return (
    event.key === "Enter" && (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)
  );
}
