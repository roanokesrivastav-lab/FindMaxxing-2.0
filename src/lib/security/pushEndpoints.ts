// Keep this provider policy in sync with 0026_security_boundaries.sql.
// Exact Google/Mozilla hosts and vendor-owned Apple/Windows subdomains;
// HTTPS, port 443 only. Apple explicitly supports all push.apple.com subdomains.
const WEB_PUSH_ENDPOINT = /^https:\/\/(?:fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|(?:[a-z0-9-]+\.)+push\.apple\.com|(?:[a-z0-9-]+\.)+notify\.windows\.com)(?::443)?\/[^\s\\#]+$/;

export function isWebPushEndpoint(endpoint: unknown): endpoint is string {
  return typeof endpoint === "string" && endpoint.length <= 1000 && !/[\u0000-\u0020\u007f]/.test(endpoint) && WEB_PUSH_ENDPOINT.test(endpoint);
}
