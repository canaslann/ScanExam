/** Preserve same-origin checks even when vinext dev constructs an HTTP Request behind direct TLS. */
export function allowedReaderOrigin(requestUrl: string, origin: string | null, options: { directHttps?: boolean; publicOrigin?: string } = {}) {
  if (!origin) return true; // Local command-line clients have no browser Origin header.
  const target = new URL(requestUrl);
  let expected = target.origin;
  if (options.publicOrigin) {
    const configured = new URL(options.publicOrigin);
    if (configured.protocol !== "https:" || configured.origin !== options.publicOrigin || configured.username || configured.password) throw new Error("SCANEXAM_PUBLIC_ORIGIN tam bir HTTPS kaynağı olmalı (yol içermemeli).");
    if (configured.host !== target.host) return false; // Reverse proxy must preserve the original host/port.
    expected = configured.origin;
  } else if (options.directHttps) expected = `https://${target.host}`;
  return origin === expected;
}
