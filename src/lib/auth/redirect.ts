const REDIRECT_BASE = new URL("https://redirect.invalid");

/** Auth destinations are canonical, same-origin paths, never external URLs. */
export function safeAuthNext(value: unknown, fallback: "/" | "/welcome" = "/"): string {
  if (typeof value !== "string" || value.length > 2048 || !value.startsWith("/") || value.startsWith("//") || /[\\\u0000-\u0020\u007f]/.test(value)) return fallback;
  try {
    const url = new URL(value, REDIRECT_BASE);
    if (url.origin !== REDIRECT_BASE.origin) return fallback;
    // Reject disguised slashes/backslashes and controls in the path too. Query
    // values (e.g. an encoded search term) do not change the redirect's origin.
    let path = url.pathname;
    for (let depth = 0; depth < 10; depth++) {
      if (path.startsWith("//") || /[\\\u0000-\u001f\u007f]/.test(path)) return fallback;
      const decoded = decodeURIComponent(path);
      if (decoded === path) return `${url.pathname}${url.search}${url.hash}`;
      path = decoded;
    }
  } catch {
    // Malformed percent escapes are not useful auth destinations.
  }
  return fallback;
}
