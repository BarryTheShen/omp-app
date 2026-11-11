/**
 * Whether a link's address names a file rather than a page (#17): a path (no scheme: `report.md`, `./a/b.csv`,
 * `/home/…`) or `file:`. A page's own anchor (`#part`) and a scheme-relative `//host` are not files.
 */
export function isFileHref(href: string): boolean {
	const trimmed = href.trim();
	if (trimmed === "" || trimmed.startsWith("#") || trimmed.startsWith("//")) return false;
	const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(trimmed)?.[1]?.toLowerCase();
	return scheme === undefined || scheme === "file";
}
