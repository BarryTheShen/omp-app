import {
  AppFailure,
  type Descriptor,
  type DescriptorId,
  type NamespaceClaim,
  type RegistryProblem,
  validateRegistry,
} from "@omp-app/contracts";
import type { DescriptorKind, Registry } from "./types";

function describeProblem(problem: RegistryProblem): string {
  return `${problem.kind} ${problem.id}: ${problem.detail}`;
}

/**
 * Validates `descriptors` with C0's `validateRegistry` and indexes the result by id and by kind.
 * Throws a readable `AppFailure` (code `internal`: a registry conflict is a bug in the app, never
 * a user-facing condition) that lists every problem found, not just the first, so a module author
 * fixes every conflict in one pass instead of one crash at a time. `ownership` defaults to C0's
 * real `NAMESPACE_OWNERSHIP` table; tests may pass a smaller one.
 */
export function createRegistry(
  descriptors: readonly unknown[],
  ownership?: readonly NamespaceClaim[],
): Registry {
  const problems = validateRegistry(descriptors, ownership);
  if (problems.length > 0) {
    const message = [
      `${problems.length} registry problem${problems.length === 1 ? "" : "s"}:`,
      ...problems.map((problem) => `- ${describeProblem(problem)}`),
    ].join("\n");
    throw new AppFailure({ code: "internal", message, retryable: false });
  }

  const valid = descriptors as readonly Descriptor[];
  const byId = new Map<DescriptorId, Descriptor>(
    valid.map((descriptor) => [descriptor.id, descriptor]),
  );
  const byKind = new Map<DescriptorKind, Descriptor[]>();
  for (const descriptor of valid) {
    const bucket = byKind.get(descriptor.kind);
    if (bucket === undefined) byKind.set(descriptor.kind, [descriptor]);
    else bucket.push(descriptor);
  }

  return { descriptors: valid, byId, byKind };
}
