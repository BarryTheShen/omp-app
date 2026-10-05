/** The app-level server information, capabilities and health contract. */
import { z } from "zod";

import { CapabilityMap } from "../../core/capabilities";
import type { PortClient, PortHandlers } from "../../core/envelope";
import { definePort } from "../../core/envelope";
import { OMP_PROTOCOL_VERSIONS } from "../../core/omp";

export const AppServerInfo = z
  .object({
    /** Changes whenever the server process restarts; stream sequence numbers restart with it. */
    instanceId: z.string().min(1),
    serverVersion: z.string().min(1),
    /** Null means the server is up but omp is not currently available. */
    omp: z
      .object({
        version: z.string().min(1),
        protocolVersion: z.union(OMP_PROTOCOL_VERSIONS.map((version) => z.literal(version))),
      })
      .nullable(),
  })
  .strict();
export type AppServerInfo = z.infer<typeof AppServerInfo>;

export const AppHealthStatus = z.enum(["ok", "degraded", "unhealthy"]);
export type AppHealthStatus = z.infer<typeof AppHealthStatus>;

export const AppHealth = z
  .object({
    status: AppHealthStatus,
    detail: z.string().optional(),
  })
  .strict();
export type AppHealth = z.infer<typeof AppHealth>;

const EmptyArgs = z.object({}).strict();

export const AppPort = definePort({
  name: "A0.app",
  methods: {
    serverInfo: {
      args: EmptyArgs,
      result: AppServerInfo,
    },
    capabilities: {
      args: EmptyArgs,
      result: CapabilityMap,
    },
    health: {
      args: EmptyArgs,
      result: AppHealth,
    },
  },
  events: {},
});

export type AppPort = typeof AppPort;
export type AppClient = PortClient<AppPort>;
export type AppHandlers<Context> = PortHandlers<AppPort, Context>;
