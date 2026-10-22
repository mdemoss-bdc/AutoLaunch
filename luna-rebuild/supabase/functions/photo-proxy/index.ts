// photo-proxy — relays a dealer photo to the AutoLaunch web app with CORS
// headers so the on-device photo engine can read it. Dealer photo servers
// (e.g. mosescars.com) send no Access-Control-Allow-Origin, so browsers
// block the app from fetching them directly. Display <img> tags don't need
// this; only the background cut-out engine does.
//
// Guards: requires the project's publishable (anon) key as apikey header —
// the same public key the app already ships — requires an http(s) image URL,
// and only streams back image/* responses up to ~12 MB.
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "apikey, authorization, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const anon = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  if (!anon || req.headers.get("apikey") !== anon) {
    return new Response("unauthorized", { status: 401, headers: cors });
  }
  const target = new URL(req.url).searchParams.get("url");
  if (!target || !/^https?:\/\//i.test(target)) {
    return new Response("bad url", { status: 400, headers: cors });
  }
  let upstream: Response;
  try {
    upstream = await fetch(target, { headers: { "User-Agent": "AutoLaunch/1.0" } });
  } catch (e) {
    return new Response("fetch failed: " + e, { status: 502, headers: cors });
  }
  if (!upstream.ok) return new Response("upstream " + upstream.status, { status: 502, headers: cors });
  const ct = upstream.headers.get("content-type") ?? "";
  if (!ct.startsWith("image/")) return new Response("not an image", { status: 415, headers: cors });
  const buf = await upstream.arrayBuffer();
  if (buf.byteLength > 12_000_000) return new Response("too large", { status: 413, headers: cors });
  return new Response(buf, {
    headers: { ...cors, "Content-Type": ct, "Cache-Control": "public, max-age=86400" },
  });
});
