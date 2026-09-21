// Cloudflare Worker: FundedNext MCP proxy for Polaris
//
// Why this exists: mcp.fundednext.com rejects cross-origin requests from
// arbitrary browser origins (confirmed directly against the deployed Polaris
// site — a plain fetch() from it fails at the network/CORS level before
// FundedNext's server even sees a token). Server-to-server requests aren't
// subject to CORS at all, so this Worker sits in between: Polaris calls this
// Worker, this Worker calls FundedNext with your real token attached, and
// hands the response back with CORS headers Polaris's origin is allowed to
// read.
//
// Your FundedNext token lives ONLY in this Worker's encrypted secret storage.
// It is never sent to, or stored in, the browser running Polaris.
//
// Deploy: Cloudflare dashboard -> Workers & Pages -> Create -> paste this file
// as the Worker's code -> Settings -> Variables and Secrets -> add two
// secrets: FUNDEDNEXT_TOKEN (your real token) and POLARIS_SHARED_SECRET (a
// random string you make up -- this is NOT your FundedNext token, it's a
// second, separate password that only Polaris and this Worker know, so a
// stranger who finds this Worker's URL can't use it to spend your FundedNext
// account's request quota).
//
// After deploying, also edit ALLOWED_ORIGIN below if your Polaris URL differs
// from the default.

const ALLOWED_ORIGIN = "https://64mpj2yrmc-jpg.github.io";
const UPSTREAM = "https://mcp.fundednext.com";

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Polaris-Secret, X-Mcp-Session-Id",
    "Access-Control-Expose-Headers": "X-Mcp-Session-Id",
  };
}

// Shaped like a JSON-RPC error response (matching what FundedNext's own server returns)
// so Polaris's client-side parsing -- which reads payload.error.message -- handles a
// worker-level error (bad secret, missing config, upstream unreachable) the exact same
// way it handles an error FundedNext itself sent back.
function jsonError(status, message) {
  return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -1, message }, id: null }), {
    status,
    headers: { ...corsHeaders(), "Content-Type": "application/json" },
  });
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }
    if (request.method !== "POST") {
      return jsonError(405, "method not allowed");
    }
    if (!env.POLARIS_SHARED_SECRET || !env.FUNDEDNEXT_TOKEN) {
      return jsonError(500, "worker is missing its secrets -- set FUNDEDNEXT_TOKEN and POLARIS_SHARED_SECRET");
    }

    // Deliberately worded so it can never be confused with an auth error FundedNext's own
    // server sends back -- Polaris's client code keys off this exact phrase to tell "the
    // shared secret is wrong" apart from "FundedNext rejected the real token".
    const providedSecret = request.headers.get("X-Polaris-Secret");
    if (!providedSecret || providedSecret !== env.POLARIS_SHARED_SECRET) {
      return jsonError(401, "polaris-worker-shared-secret-mismatch");
    }

    const body = await request.text();
    const sessionId = request.headers.get("X-Mcp-Session-Id");
    const upstreamHeaders = {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
      "Authorization": "Bearer " + env.FUNDEDNEXT_TOKEN,
    };
    if (sessionId) upstreamHeaders["Mcp-Session-Id"] = sessionId;

    let upstreamRes;
    try {
      upstreamRes = await fetch(UPSTREAM, { method: "POST", headers: upstreamHeaders, body });
    } catch (e) {
      return jsonError(502, "upstream request failed: " + e.message);
    }

    const headers = corsHeaders();
    headers["Content-Type"] = upstreamRes.headers.get("Content-Type") || "application/json";
    const upstreamSessionId = upstreamRes.headers.get("Mcp-Session-Id");
    if (upstreamSessionId) headers["X-Mcp-Session-Id"] = upstreamSessionId;

    const responseBody = await upstreamRes.text();
    return new Response(responseBody, { status: upstreamRes.status, headers });
  },
};
