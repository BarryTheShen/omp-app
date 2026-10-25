import { checkScrubbed, INVENTORY, validateRegistry } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import { COLLABORATION_CAPABILITY } from "../../contract";
import { I4_DESCRIPTORS, I4_GUEST_PROMPT_DESCRIPTOR } from "../../descriptors";
import { I4_FIXTURES } from "../../fixtures";

const I4_INVENTORY_IDS = [
  "C5.collab",
  "C5.join",
  "C5.leave",
  "C5.collab-status",
  "C5.collab-stop",
  "C5.collab-view",
  "C5.collaboration-host-guest",
  "C5.collab-guest-prompt",
  "S3.interaction-stream",
] as const;

describe("I4.5 descriptor and AP6 acceptance", () => {
  test("claims exactly the eight C5 rows and Stream settings row", () => {
    const claimed = I4_DESCRIPTORS.flatMap((descriptor) => descriptor.covers);
    expect(new Set(claimed)).toEqual(new Set(I4_INVENTORY_IDS));
    expect(claimed).toHaveLength(I4_INVENTORY_IDS.length);
    expect(validateRegistry(I4_DESCRIPTORS)).toEqual([]);
    expect(
      INVENTORY.filter((item) =>
        I4_INVENTORY_IDS.includes(item.id as (typeof I4_INVENTORY_IDS)[number]),
      ),
    ).toHaveLength(I4_INVENTORY_IDS.length);
  });

  test("the guest-prompt row matches the custom message type omp writes, not the app's AP6 event name", () => {
    // omp v18.12.6, packages/wire/src/index.ts:170 (COLLAB_PROMPT_MESSAGE_TYPE); the app's event is `collab_guest_prompt`.
    expect(I4_GUEST_PROMPT_DESCRIPTOR.match).toEqual({
      by: "customType",
      customType: "collab-prompt",
    });
  });

  test("gates every collaboration descriptor on the typed AP6 capability", () => {
    const collaboration = I4_DESCRIPTORS.filter((descriptor) =>
      descriptor.covers.some((id) => id.startsWith("C5.")),
    );
    expect(collaboration).toHaveLength(8);
    // The capability the descriptors require is the one the v18.8.9 fixture reports unavailable, so the controls stay hidden.
    expect(I4_FIXTURES.unavailable.capabilities[COLLABORATION_CAPABILITY]).toMatchObject({
      state: "unavailable",
      via: "upstream",
    });
    expect(
      collaboration.every((descriptor) => descriptor.requires.includes(COLLABORATION_CAPABILITY)),
    ).toBe(true);
    expect(I4_FIXTURES.unavailable.result).toMatchObject({
      state: "unavailable",
      error: { code: "unavailable", capability: COLLABORATION_CAPABILITY, retryable: false },
    });
    expect(I4_FIXTURES.available.capabilities[COLLABORATION_CAPABILITY]).toMatchObject({
      state: "available",
      via: "rpc",
    });
  });

  test("scrubs the complete AP6 fixture object", () => {
    expect(checkScrubbed(JSON.stringify(I4_FIXTURES))).toEqual([]);
  });
});
