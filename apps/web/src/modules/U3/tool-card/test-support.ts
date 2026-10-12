import { fireEvent } from "@testing-library/react";

/** The disclosure button of a card that is still one line. */
const COLLAPSED_TRIGGER = '[data-slot="u3-tool-card-trigger"][aria-expanded="false"]';

/** A card inside another card's body mounts only once that body is open, so opening repeats this many times. */
const MAX_NESTING_PASSES = 8;

/**
 * Opens every collapsed tool card on screen, the way a person clicks each call's line. A card's body
 * mounts only while the card is open, so a test that reads a body calls this after rendering it.
 */
export function expandToolCards(): void {
  for (let pass = 0; pass < MAX_NESTING_PASSES; pass += 1) {
    const collapsed = document.querySelectorAll<HTMLElement>(COLLAPSED_TRIGGER);
    if (collapsed.length === 0) return;
    for (const trigger of collapsed) fireEvent.click(trigger);
  }
}
