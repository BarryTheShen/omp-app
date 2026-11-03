/** The base the preview gives a page: relative links resolve to nothing, and links to a part of the page still work. */
const BASE = '<base href="about:srcdoc">';

/**
 * An HTML file as the Files preview shows it, in a sandboxed `srcdoc` frame. Such a frame resolves a page's relative
 * links against the app's own address, so its stylesheets, pictures and fetches went to the app (every engine asks;
 * WebKit logs the misses). With this base they lead nowhere: the preview loads nothing from the app's address. Share as
 * a page shows the page with its files. A doctype stays first, so the page keeps its rendering mode.
 */
export function previewDocument(html: string): string {
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  if (doctype === null) return `${BASE}${html}`;
  return `${doctype[0]}${BASE}${html.slice(doctype[0].length)}`;
}
