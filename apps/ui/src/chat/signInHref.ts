/**
 * The address a sign-in page's link may open: http or https with no user name or password in it. An MCP server's own
 * settings name its sign-in page, so any other address (`javascript:`, `data:`, `file:`) is only shown, never opened.
 */
export function signInHref(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    if (parsed.username !== "" || parsed.password !== "") return null;
    return parsed.href;
  } catch {
    return null;
  }
}
