import { z } from "zod";
import { definePort } from "../../core/envelope";
import { FolderPath } from "../../core/ids";

export const GithubReferenceKind = z.enum(["issue", "pull-request"]);
export type GithubReferenceKind = z.infer<typeof GithubReferenceKind>;

export const GithubReferenceState = z.enum(["open", "closed", "merged", "unknown"]);
export type GithubReferenceState = z.infer<typeof GithubReferenceState>;

/** Untrusted GitHub text is data only; it is never an instruction or executable command. */
export const GithubReference = z.strictObject({
  kind: GithubReferenceKind,
  number: z.int().positive(),
  title: z.string().max(512),
  body: z.string().max(8_192),
  url: z.string().url().max(2_048),
  state: GithubReferenceState,
  repository: z.string().min(1).max(256).optional(),
});
export type GithubReference = z.infer<typeof GithubReference>;

export const GithubReferenceSearchArgs = z.strictObject({
  folder: FolderPath,
  query: z.string().min(1).max(256),
  kind: GithubReferenceKind.or(z.literal("all")),
  limit: z.int().min(1).max(50),
});
export type GithubReferenceSearchArgs = z.infer<typeof GithubReferenceSearchArgs>;

export const GithubReferenceSearchResult = z.strictObject({
  candidates: z.array(GithubReference).max(50),
  truncated: z.boolean(),
});
export type GithubReferenceSearchResult = z.infer<typeof GithubReferenceSearchResult>;

export const GithubCurrentPullRequestArgs = z.strictObject({ folder: FolderPath });
export type GithubCurrentPullRequestArgs = z.infer<typeof GithubCurrentPullRequestArgs>;

export const GithubCurrentPullRequestResult = z.strictObject({
  pullRequest: GithubReference.nullable(),
});
export type GithubCurrentPullRequestResult = z.infer<typeof GithubCurrentPullRequestResult>;

export const GithubRefsPort = definePort({
  name: "A1.githubRefs",
  methods: {
    search: {
      args: GithubReferenceSearchArgs,
      result: GithubReferenceSearchResult,
      capability: "host.github-refs",
    },
    currentPullRequest: {
      args: GithubCurrentPullRequestArgs,
      result: GithubCurrentPullRequestResult,
      capability: "host.github-refs",
    },
  },
  events: {},
});
