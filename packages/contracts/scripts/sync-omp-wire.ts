/**
 * Refreshes the vendored omp wire files in `src/omp-wire/` from an omp release tag.
 *
 *   bun scripts/sync-omp-wire.ts <tag>        (run in packages/contracts)
 *
 * It resolves the tag to its commit, downloads every file pinned to that commit, writes the
 * bytes unchanged, and records tag, commit, source URL, sha256 and size per file in
 * `src/omp-wire/PROVENANCE.md`. The copied files are never edited by hand; rerun this script.
 */
import { join } from "node:path";

const REPO = "can1357/oh-my-pi";
const FILES = [
  {
    source: "packages/coding-agent/src/modes/rpc/wire/rpc-wire.generated.ts",
    target: "rpc-wire.generated.ts",
  },
  {
    source: "packages/coding-agent/src/modes/rpc/wire/rpc-wire.schema.json",
    target: "rpc-wire.schema.json",
  },
  { source: "LICENSE", target: "LICENSE" },
] as const;

const TAG_PATTERN = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const OUT_DIR = join(import.meta.dir, "..", "src", "omp-wire");
const HEADERS = { "User-Agent": "omp-app-sync-omp-wire", Accept: "application/vnd.github+json" };

interface GitObjectRef {
  sha: string;
  type: string;
}

function readObjectRef(value: unknown, what: string): GitObjectRef {
  const object = (value as { object?: { sha?: unknown; type?: unknown } } | null)?.object;
  if (typeof object?.sha !== "string" || typeof object.type !== "string") {
    throw new Error(`Unexpected GitHub response for ${what}`);
  }
  return { sha: object.sha, type: object.type };
}

async function getJson(url: string): Promise<unknown> {
  const response = await fetch(url, { headers: HEADERS });
  if (!response.ok) {
    throw new Error(`GET ${url} failed: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

/** Follows the tag ref (and annotated tag objects) to the commit it names. */
async function resolveCommit(tag: string): Promise<string> {
  const api = `https://api.github.com/repos/${REPO}/git`;
  let ref = readObjectRef(await getJson(`${api}/ref/tags/${tag}`), `tag ${tag}`);
  for (let depth = 0; ref.type === "tag"; depth++) {
    if (depth > 4) throw new Error(`Tag ${tag} nests too many annotated tags`);
    ref = readObjectRef(await getJson(`${api}/tags/${ref.sha}`), `tag object ${ref.sha}`);
  }
  if (ref.type !== "commit" || !SHA_PATTERN.test(ref.sha)) {
    throw new Error(`Tag ${tag} does not point at a commit (got ${ref.type} ${ref.sha})`);
  }
  return ref.sha;
}

async function main(): Promise<void> {
  const tag = process.argv[2];
  if (tag === undefined || !TAG_PATTERN.test(tag)) {
    console.error("usage: bun scripts/sync-omp-wire.ts <tag>   (for example v18.6.1)");
    process.exit(1);
  }

  const commit = await resolveCommit(tag);
  const rows: string[] = [];
  let licenseTitle = "";
  for (const file of FILES) {
    const url = `https://raw.githubusercontent.com/${REPO}/${commit}/${file.source}`;
    const response = await fetch(url, { headers: { "User-Agent": HEADERS["User-Agent"] } });
    if (!response.ok) {
      throw new Error(`GET ${url} failed: ${response.status} ${response.statusText}`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (file.target.endsWith(".json")) JSON.parse(text);
    if (file.target === "LICENSE") {
      licenseTitle = text.split("\n").find((line) => line.trim() !== "") ?? "";
    }
    await Bun.write(join(OUT_DIR, file.target), bytes);
    const digest = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
    rows.push(`| \`${file.target}\` | ${url} | \`${digest}\` | ${bytes.byteLength} |`);
  }

  const provenance = [
    "# omp wire files: provenance",
    "",
    "Written by `scripts/sync-omp-wire.ts`. The files in this folder are copied byte for byte from",
    "omp and are never edited by hand; to refresh them, run `bun scripts/sync-omp-wire.ts <tag>`",
    "in `packages/contracts`.",
    "",
    `- Repository: https://github.com/${REPO}`,
    `- Tag: \`${tag}\``,
    `- Commit: \`${commit}\``,
    `- License: ${licenseTitle.trim()} (\`LICENSE\`, copied from the repository root)`,
    "",
    "| File | Source | sha256 | Bytes |",
    "|---|---|---|---|",
    ...rows,
    "",
  ].join("\n");
  await Bun.write(join(OUT_DIR, "PROVENANCE.md"), provenance);
  console.log(`omp wire files synced from ${tag} (${commit})`);
}

await main();
