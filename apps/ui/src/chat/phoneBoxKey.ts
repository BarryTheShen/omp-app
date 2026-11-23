/**
 * A key in a phone's message box (＋, ⚡, Send or Stop): a finger's 44 pt in every style, never 11 × the style's
 * `--spacing` (53 pt in Roomy, which took the text's room and made the box taller), with corners that follow the box's:
 * its radius (`--box-r`, set by the style) less the 4 pt between them (the box's 3 pt inset and 1 pt border).
 */
export const PHONE_BOX_KEY = "size-[44px] shrink-0 rounded-[max(calc(var(--box-r)_-_4px),2px)]";
