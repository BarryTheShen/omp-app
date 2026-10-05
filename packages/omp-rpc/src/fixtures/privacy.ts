import type { FixtureFrame } from "@omp-app/contracts";

/** Matches omp v18.6.1's legacy absolute-cwd session bucket encoding. */
export function encodeLegacySessionBucket(cwd: string): string {
  return `--${cwd.replace(/^[/\\]/, "").replace(/[\\/:]/g, "-")}--`;
}

/** Fails closed when a captured frame contains an exact non-empty instruction-file line. */
export function assertNoInstructionContent(
  frames: readonly FixtureFrame[],
  lines: readonly string[],
): void {
  for (const line of lines) {
    const candidate = line.trim();
    if (candidate.length < 8) continue;
    const frame = frames.find((item) => item.line.includes(candidate));
    if (frame !== undefined) throw new Error("Fixture contains instruction-file content");
  }
}
