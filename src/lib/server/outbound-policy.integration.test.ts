#!/usr/bin/env node
/**
 * T05 integration: the real Node transport honours the pinned address.
 *
 * The unit tests inject a fake transport, which cannot prove the *real* socket
 * goes where validation decided. This one binds a real loopback server and asks
 * the real transport for a hostname that does not resolve at all: if the
 * `lookup` hook were ignored, the request would fail with DNS_ENOTFOUND. Getting
 * the server's answer back proves the connection used the pinned address.
 *
 * Loopback only, no network egress, no external service.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { createPinnedLookup, pinnedTransport, publicFetch } from "./outbound-policy.ts";
import type { IncomingMessage, ServerResponse } from "node:http";

/** Start an HTTP server on an ephemeral loopback port. */
async function loopbackServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { server, port, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

test("the real transport connects to the pinned address, not a fresh lookup", async () => {
  const { port, close } = await loopbackServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("pinned-ok");
  });
  try {
    // This hostname is intentionally unresolvable: only the lookup hook can
    // produce an address for it.
    const url = new URL(`http://loom-pinning-probe.invalid:${port}/feed`);
    const lookup = createPinnedLookup(["127.0.0.1"]);
    const response = await pinnedTransport()(url, { lookup, timeoutMs: 5000 });
    assert.equal(response.status, 200);

    // The real transport yields an async iterable (IncomingMessage).
    const chunks: Buffer[] = [];
    for await (const chunk of response.body as AsyncIterable<Buffer>) chunks.push(chunk);
    assert.equal(Buffer.concat(chunks).toString("utf8"), "pinned-ok");
  } finally {
    await close();
  }
});

test("without a pinned lookup the request does not reach the loopback server (control)", async () => {
  // The security property, not a specific DNS error: an unresolvable/foreign
  // hostname must not land on our loopback server just because the port is open.
  // (This host's resolver answers every name, so asserting a DNS error code would
  // be asserting the local network, not the code under test.)
  let reached = false;
  const { port, close } = await loopbackServer((_req: IncomingMessage, res: ServerResponse) => {
    reached = true;
    res.end("should-not-reach");
  });
  try {
    const url = new URL(`http://loom-pinning-probe.invalid:${port}/feed`);
    const outcome = await pinnedTransport()(url, { timeoutMs: 3000 })
      .then(() => "connected")
      .catch((err) => `rejected:${err?.code ?? err?.message}`);
    assert.equal(reached, false, `the unpinned request reached loopback (${outcome})`);
  } finally {
    await close();
  }
});

test("a timeout destroys the request instead of hanging", async () => {
  const { port, close } = await loopbackServer(() => {
    // Never respond: the transport must give up on its own.
  });
  try {
    const url = new URL(`http://slow-probe.invalid:${port}/feed`);
    const lookup = createPinnedLookup(["127.0.0.1"]);
    await assert.rejects(
      () => pinnedTransport()(url, { lookup, timeoutMs: 300 }),
      /timeout/,
    );
  } finally {
    await close();
  }
});

test("publicFetch total deadline closes a real socket even while bytes keep arriving", async () => {
  let closed = false;
  const { port, close } = await loopbackServer((_req, res) => {
    res.writeHead(200);
    const drip = setInterval(() => res.write("x"), 10);
    res.on("close", () => { closed = true; clearInterval(drip); });
  });
  const started = Date.now();
  try {
    await assert.rejects(() => publicFetch("http://example.com/feed", {
      timeoutMs: 150,
      resolver: { async lookup() { return [{ address: "93.184.216.34", family: 4 }]; } },
      // Test-only socket routing after the real public URL/DNS checks.
      transport: (url, options) => pinnedTransport()(new URL(`http://${url.hostname}:${port}/feed`), {
        ...options, lookup: createPinnedLookup(["127.0.0.1"]),
      }),
    }), /timeout|aborted/i);
    assert.ok(Date.now() - started < 1000);
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(closed, true, "deadline must destroy the server-side socket");
  } finally { await close(); }
});

test("a redirect response surfaces its Location for the caller to re-validate", async () => {
  const { port, close } = await loopbackServer((_req, res) => {
    res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" });
    res.end();
  });
  try {
    const url = new URL(`http://redirect-probe.invalid:${port}/feed`);
    const lookup = createPinnedLookup(["127.0.0.1"]);
    const response = await pinnedTransport()(url, { lookup, timeoutMs: 5000 });
    assert.equal(response.status, 302);
    assert.equal(response.headers.location, "http://169.254.169.254/latest/meta-data/");
  } finally {
    await close();
  }
});
