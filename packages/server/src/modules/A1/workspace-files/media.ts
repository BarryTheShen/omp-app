import { extname } from "node:path";

/**
 * A file's media type from its name, for the Files panel's viewers (#2782): text and code as `text/*` (or the JSON, XML
 * and TOML types), and the image, PDF, audio and video types the browser shows. Its own table, because a general MIME
 * table names source files wrongly (Bun's: `.py` unknown, `.rs` an XML service list).
 */
const BY_EXTENSION: ReadonlyMap<string, string> = new Map(
  Object.entries({
    // Text and code.
    txt: "text/plain",
    log: "text/plain",
    text: "text/plain",
    ini: "text/plain",
    cfg: "text/plain",
    conf: "text/plain",
    env: "text/plain",
    md: "text/markdown",
    markdown: "text/markdown",
    mdx: "text/markdown",
    rst: "text/x-rst",
    csv: "text/csv",
    tsv: "text/tab-separated-values",
    json: "application/json",
    jsonc: "application/json",
    jsonl: "application/x-ndjson",
    ndjson: "application/x-ndjson",
    ipynb: "application/x-ipynb+json",
    yaml: "text/yaml",
    yml: "text/yaml",
    toml: "application/toml",
    xml: "application/xml",
    html: "text/html",
    htm: "text/html",
    css: "text/css",
    scss: "text/x-scss",
    sass: "text/x-sass",
    less: "text/x-less",
    js: "text/javascript",
    mjs: "text/javascript",
    cjs: "text/javascript",
    jsx: "text/javascript",
    ts: "text/typescript",
    tsx: "text/typescript",
    mts: "text/typescript",
    cts: "text/typescript",
    py: "text/x-python",
    pyi: "text/x-python",
    rb: "text/x-ruby",
    rs: "text/x-rust",
    go: "text/x-go",
    java: "text/x-java",
    kt: "text/x-kotlin",
    swift: "text/x-swift",
    c: "text/x-c",
    h: "text/x-c",
    cc: "text/x-c++",
    cpp: "text/x-c++",
    cxx: "text/x-c++",
    hpp: "text/x-c++",
    cs: "text/x-csharp",
    php: "text/x-php",
    sh: "text/x-shellscript",
    bash: "text/x-shellscript",
    zsh: "text/x-shellscript",
    fish: "text/x-shellscript",
    sql: "text/x-sql",
    lua: "text/x-lua",
    r: "text/x-r",
    jl: "text/x-julia",
    tex: "text/x-tex",
    bib: "text/x-bibtex",
    diff: "text/x-diff",
    patch: "text/x-diff",
    // Images (SVG is shown through <img> only, so its scripts never run).
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    avif: "image/avif",
    bmp: "image/bmp",
    ico: "image/x-icon",
    svg: "image/svg+xml",
    pdf: "application/pdf",
    // Audio and video.
    mp3: "audio/mpeg",
    wav: "audio/wav",
    ogg: "audio/ogg",
    oga: "audio/ogg",
    opus: "audio/ogg",
    flac: "audio/flac",
    m4a: "audio/mp4",
    aac: "audio/aac",
    mp4: "video/mp4",
    m4v: "video/mp4",
    webm: "video/webm",
    mov: "video/quicktime",
    ogv: "video/ogg",
  }),
);

/** Names that are text without an extension. */
const TEXT_NAMES: ReadonlySet<string> = new Set([
  "makefile",
  "dockerfile",
  "license",
  "readme",
  "changelog",
  ".gitignore",
  ".gitattributes",
  ".editorconfig",
  ".env",
  ".npmrc",
]);

export const UNKNOWN_MEDIA_TYPE = "application/octet-stream";

export function mediaTypeOf(name: string): string {
  const extension = extname(name).slice(1).toLowerCase();
  const known = extension === "" ? undefined : BY_EXTENSION.get(extension);
  if (known !== undefined) return known;
  return TEXT_NAMES.has(name.toLowerCase()) ? "text/plain" : UNKNOWN_MEDIA_TYPE;
}
