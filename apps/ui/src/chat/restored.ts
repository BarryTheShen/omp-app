/**
 * Text that comes back to the message box (an edited message, or messages omp's queue gave back), put in front of what
 * the box holds. Text the box holds already, as whole paragraphs, is not put in a second time.
 */
export function withRestored(restored: readonly string[], current: string): string {
  const held = `\n\n${current}\n\n`;
  const fresh = restored.filter((part) => !held.includes(`\n\n${part}\n\n`));
  return [...fresh, current].filter((part) => part.trim() !== "").join("\n\n");
}
