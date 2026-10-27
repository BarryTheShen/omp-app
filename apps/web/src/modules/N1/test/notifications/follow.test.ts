import type { ChatSessionEvent } from "@omp-app/contracts";
import { ThreadId as ThreadIdSchema } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import { OmpRuntimeStore } from "../../../R0/store";
import { NotificationProjector } from "../../notifications";

const chatA = ThreadIdSchema.parse("thread-follow-a");
const chatB = ThreadIdSchema.parse("thread-follow-b");

/** One omp event as a chat's stream applies it. The cast is the boundary to the store's typed event union. */
function omp(store: OmpRuntimeStore, event: Record<string, unknown>, seq: number): void {
  store.ingest({ kind: "event", event } as unknown as ChatSessionEvent, seq);
}

function noticeEvent(message: string): Record<string, unknown> {
  return { type: "notice", level: "warning", message };
}

/** The notices on the bus, as `chat:message`. */
function shown(projector: NotificationProjector): string[] {
  return projector
    .getBus()
    .getSnapshot()
    .notifications.map((notification) => `${notification.threadId}:${notification.message}`);
}

describe("a presentation is attributed to the chat it arrives in", () => {
  test("a notify routed for chat B is recorded under chat B, though the projector was shown with chat A", () => {
    const storeA = new OmpRuntimeStore({ threadId: chatA });
    const projector = new NotificationProjector({ source: storeA, events: storeA });
    projector.present(
      { kind: "notify", message: "for chat B", notifyType: "warning" },
      {
        threadId: chatB,
      },
    );
    expect(shown(projector)).toEqual([`${chatB}:for chat B`]);
  });
});

describe("a projector follows the store of the chat on screen", () => {
  test("after follow, the new chat's events are projected and the old chat's are not", () => {
    const storeA = new OmpRuntimeStore({ threadId: chatA });
    const storeB = new OmpRuntimeStore({ threadId: chatB });
    const projector = new NotificationProjector({ source: storeA, events: storeA });
    projector.follow(storeB);
    omp(storeB, noticeEvent("chat B warning"), 1);
    omp(storeA, noticeEvent("chat A late"), 2);
    expect(shown(projector)).toEqual([`${chatB}:chat B warning`]);
  });

  test("the sequence gate starts again for the new chat, whose events are numbered from 1", () => {
    const storeA = new OmpRuntimeStore({ threadId: chatA });
    const projector = new NotificationProjector({ source: storeA, events: storeA });
    for (let seq = 1; seq <= 5; seq += 1) omp(storeA, noticeEvent(`A${seq}`), seq);
    const storeB = new OmpRuntimeStore({ threadId: chatB });
    projector.follow(storeB);
    omp(storeB, noticeEvent("B1"), 1);
    expect(shown(projector)).toContain(`${chatB}:B1`);
  });

  test("statuses of one chat are not shown in another", () => {
    const storeA = new OmpRuntimeStore({ threadId: chatA });
    const projector = new NotificationProjector({ source: storeA, events: storeA });
    projector.present(
      { kind: "setStatus", statusKey: "build", statusText: "building" },
      { threadId: chatA },
    );
    expect(projector.getSnapshot().statuses.map((status) => status.statusKey)).toEqual(["build"]);
    projector.follow(new OmpRuntimeStore({ threadId: chatB }));
    expect(projector.getSnapshot().statuses).toEqual([]);
  });

  test("an event the new chat applied before the projector followed it is projected on follow", () => {
    const storeA = new OmpRuntimeStore({ threadId: chatA });
    const projector = new NotificationProjector({ source: storeA, events: storeA });
    const storeB = new OmpRuntimeStore({ threadId: chatB });
    // A chat's replayed history arrives as its stream opens, before the page has followed the chat (issue 2181).
    omp(storeB, noticeEvent("replayed B"), 1);
    projector.follow(storeB);
    expect(shown(projector)).toEqual([`${chatB}:replayed B`]);
  });

  test("following the store already followed changes nothing", () => {
    const storeA = new OmpRuntimeStore({ threadId: chatA });
    const projector = new NotificationProjector({ source: storeA, events: storeA });
    omp(storeA, noticeEvent("once"), 1);
    projector.follow(storeA);
    omp(storeA, noticeEvent("twice"), 2);
    expect(shown(projector)).toEqual([`${chatA}:once`, `${chatA}:twice`]);
  });
});
