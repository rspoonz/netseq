// Request checks for a server with no login that only listens on 127.0.0.1.
// Websites open in the same browser can still send requests to localhost, so:
// - the Host header must be a local name, or one listed in NETSEQ_HOSTS (a proxy's, say),
//   which blocks DNS rebinding;
// - writes must be JSON (a plain cross-site form can't send that) and not marked cross-site.
// Tools like curl send no Sec-Fetch-Site header, and are allowed.

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1"]);

/** Host names from a comma-separated list, as in NETSEQ_HOSTS="notes.example". */
export function parseHosts(list: string | undefined): Set<string> {
  return new Set((list ?? "").split(",").map((host) => host.trim().toLowerCase()).filter(Boolean));
}

/** Null if the request may go ahead; otherwise the response that refuses it. */
export function checkRequest(req: Request, extraHosts: ReadonlySet<string> = new Set()): Response | null {
  const host = (req.headers.get("host") ?? "").replace(/:\d+$/, "").toLowerCase();
  if (!LOCAL_HOSTS.has(host) && !extraHosts.has(host)) return new Response("Forbidden", { status: 403 });

  if (req.method === "GET" || req.method === "HEAD") return null;
  if (!(req.headers.get("content-type") ?? "").startsWith("application/json")) {
    return new Response("Expected JSON", { status: 415 });
  }
  const site = req.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin") return new Response("Forbidden", { status: 403 });
  return null;
}

const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy":
    "default-src 'self'; img-src 'self' data: https:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

export function withSecurityHeaders(res: Response): Response {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.headers.set(name, value);
  return res;
}
