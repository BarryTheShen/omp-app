import type { CapabilityMap, ToolDescriptor } from "@omp-app/contracts";
import { createRegistry } from "../../../registry-core/create-registry";
import { isDescriptorAvailable } from "../../../registry-core/hooks";
import type { ToolRegistryDescriptor, ToolRenderer } from "./contract";
import { ToolFallback as DefaultToolFallback } from "./fallback";

export interface ToolResolution {
  readonly toolName: string;
  readonly descriptor?: ToolRegistryDescriptor;
  readonly renderer: ToolRenderer;
  readonly available: boolean;
  readonly fallback: boolean;
}

export interface ToolRegistry {
  readonly descriptors: readonly ToolRegistryDescriptor[];
  resolve(toolName: string, capabilities?: CapabilityMap): ToolResolution;
}

/**
 * Builds one deterministic tool resolver. C0 validates duplicate exact/prefix/fallback claims;
 * resolution then prefers exact names, the longest prefix, and finally the one fallback.
 */
export function createToolRegistry(
  descriptors: readonly ToolRegistryDescriptor[],
  fallback: ToolRenderer = DefaultToolFallback,
): ToolRegistry {
  createRegistry(descriptors);
  const exact = new Map<string, ToolRegistryDescriptor>();
  const prefixes: ToolRegistryDescriptor[] = [];
  let fallbackDescriptor: ToolRegistryDescriptor | undefined;
  for (const descriptor of descriptors) {
    if (descriptor.match.by === "name") exact.set(descriptor.match.name, descriptor);
    else if (descriptor.match.by === "prefix") prefixes.push(descriptor);
    else fallbackDescriptor = descriptor;
  }
  prefixes.sort((left, right) => {
    if (left.match.by !== "prefix" || right.match.by !== "prefix") return 0;
    return right.match.prefix.length - left.match.prefix.length;
  });

  return {
    descriptors,
    resolve(toolName, capabilities = {}) {
      const descriptor =
        exact.get(toolName) ??
        prefixes.find(
          (candidate) =>
            candidate.match.by === "prefix" && toolName.startsWith(candidate.match.prefix),
        ) ??
        fallbackDescriptor;
      if (descriptor === undefined) {
        return {
          toolName,
          renderer: fallback,
          available: false,
          fallback: true,
        };
      }
      return {
        toolName,
        descriptor,
        renderer: descriptor.renderer,
        available: isDescriptorAvailable(descriptor as ToolDescriptor, capabilities),
        fallback: descriptor.match.by === "fallback",
      };
    },
  };
}
