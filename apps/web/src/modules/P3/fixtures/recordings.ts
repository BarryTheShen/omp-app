/** P3's recorded chat sessions (`recordings/`, in R0's session recording format: `R0/fixtures/recorded-session.ts`), parsed. */
import { parseRecording } from "@/modules/R0/fixtures/recorded-session";
import branchText from "./recordings/p3-branch.session.jsonl?raw";
import branchCancelledText from "./recordings/p3-branch-cancelled.session.jsonl?raw";
import branchImageText from "./recordings/p3-branch-image.session.jsonl?raw";
import branchMessagesText from "./recordings/p3-branch-messages.session.jsonl?raw";
import branchSummaryText from "./recordings/p3-branch-summary.session.jsonl?raw";
import providerErrorText from "./recordings/p3-provider-error.session.jsonl?raw";

/** A prompt, then a branch from it that omp accepts. */
export const P3_BRANCH = parseRecording(branchText);
/** A prompt, then a branch from it that an extension's hook cancels. */
export const P3_BRANCH_CANCELLED = parseRecording(branchCancelledText);
/** A prompt with only an image, then `get_branch_messages`. */
export const P3_BRANCH_IMAGE = parseRecording(branchImageText);
/** Four prompts (one image-only, one abandoned by a branch), then `get_branch_messages`. */
export const P3_BRANCH_MESSAGES = parseRecording(branchMessagesText);
/** A prompt, then a branch with a summary of the branch left behind. */
export const P3_BRANCH_SUMMARY = parseRecording(branchSummaryText);
/** A prompt whose provider fails with a retryable 503. */
export const P3_PROVIDER_ERROR = parseRecording(providerErrorText);
