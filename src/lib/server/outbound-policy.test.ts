#!/usr/bin/env node
/**
 * T05: outbound download policy tests.
 *
 * Fixtures inject a resolver and a body stream, so the suite is offline and
 * deterministic. There is deliberately NO "allow all private addresses" test
 * backdoor: production code has no such switch, so tests cannot depend on one.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  addressBlocked,
  assertPublicUrl,
  capFor,
  hostBlocked,
  publicFetch,
  readCapped,
  resolvePublicAddresses,
  type BodyLike,
  type DnsResolver,
  type LookupHook,
  type OutboundTransport,
  MEDIA_MAX_BYTES,
  TEXT_MAX_BYTES,
} from "./outbound-policy.ts";

function resolverFor(map: Record<string, string[]>): DnsResolver {
  return {
    async lookup(hostname: string, options: { all: true; verbatim?: boolean }) {
      const answers = map[hostname];
      if (!answers) throw new Error("dns_not_found");
      void options;
      return answers.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
    },
  };
}

test("protocol and credential boundaries", () => {
  assert.ok(assertPublicUrl("https://example.com/feed.xml"));
  assert.ok(assertPublicUrl("http://example.com/feed.xml"));
  for (const bad of [
    "file:///etc/passwd",
    "ftp://example.com/f",
    "gopher://example.com/",
    "data:text/plain,hi",
    "javascript:alert(1)",
    "https://user:pass@example.com/feed",
    "https://user@example.com/feed",
    "not a url",
  ]) {
    assert.throws(() => assertPublicUrl(bad), /unsupported_protocol|url_credentials_not_allowed|invalid_url/, bad);
  }
});

test("loopback, RFC1918, link-local and metadata addresses are blocked", () => {
  for (const address of [
    "127.0.0.1",
    "127.1.2.3",
    "0.0.0.0",
    "10.0.0.5",
    "172.16.0.1",
    "172.31.255.254",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "224.0.0.1",
    "255.255.255.255",
    "::1",
    "::",
    "fe80::1",
    "fd00::1",
    "fc00::1",
    "ff02::1",
    "::ffff:127.0.0.1",
    "::ffff:10.1.1.1",
  ]) {
    assert.equal(addressBlocked(address), true, `should be blocked: ${address}`);
  }
});

test("public addresses stay allowed", () => {
  for (const address of [
    "8.8.8.8",
    "1.1.1.1",
    "93.184.216.34",
    "172.32.0.1",
    "172.15.255.255",
    "192.169.0.1",
    "100.128.0.1",
    "2606:4700::1111",
    "::ffff:8.8.8.8",
  ]) {
    assert.equal(addressBlocked(address), false, `should be allowed: ${address}`);
  }
});

test("internal hostnames are blocked by name", () => {
  for (const host of ["localhost", "api.localhost", "printer.local", "vault.internal", "metadata.google.internal", "LOCALHOST"]) {
    assert.equal(hostBlocked(host), true, host);
  }
  assert.equal(hostBlocked("example.com"), false);
});

test("a literal IP never bypasses the address check", async () => {
  await assert.rejects(() => resolvePublicAddresses("127.0.0.1", resolverFor({})), /blocked_address/);
  await assert.rejects(() => resolvePublicAddresses("[::1]", resolverFor({})), /blocked_address/);
  await assert.rejects(() => resolvePublicAddresses("169.254.169.254", resolverFor({})), /blocked_address/);
  assert.deepEqual(await resolvePublicAddresses("8.8.8.8", resolverFor({})), ["8.8.8.8"]);
});

test("a mixed DNS answer set is refused even if one address is public", async () => {
  const mixed = resolverFor({ "evil.example": ["93.184.216.34", "10.0.0.7"] });
  await assert.rejects(() => resolvePublicAddresses("evil.example", mixed), /blocked_address/);

  const reordered = resolverFor({ "evil.example": ["10.0.0.7", "93.184.216.34"] });
  await assert.rejects(() => resolvePublicAddresses("evil.example", reordered), /blocked_address/);
});

test("a fully public answer set resolves", async () => {
  const ok = resolverFor({ "example.com": ["93.184.216.34", "2606:4700::1111"] });
  assert.deepEqual(await resolvePublicAddresses("example.com", ok), ["93.184.216.34", "2606:4700::1111"]);
});

test("an empty answer set is an error, not a pass", async () => {
  const empty = resolverFor({});
  await assert.rejects(() => resolvePublicAddresses("nothing.example", empty), /dns_not_found|dns_no_answer/);
});

/** Minimal stand-in for a fetch body: yields the given chunks. */
function bodyOf(chunks: (string | Uint8Array)[], { onCancel }: { onCancel?: () => void } = {}): BodyLike {
  let index = 0;
  return {
    getReader() {
      return {
        async read() {
          if (index >= chunks.length) return { done: true, value: undefined };
          const value = chunks[index++];
          return { done: false, value: typeof value === "string" ? new TextEncoder().encode(value) : value };
        },
        async cancel() {
          onCancel?.();
          index = chunks.length;
        },
        releaseLock() {},
      };
    },
  };
}

test("a streamed body over the cap is rejected mid-read and the stream cancelled", async () => {
  let cancelled = false;
  const chunk = new Uint8Array(1024 * 1024); // 1 MiB
  const body = bodyOf([chunk, chunk, chunk, chunk, chunk], { onCancel: () => { cancelled = true; } });
  await assert.rejects(() => readCapped(body, TEXT_MAX_BYTES), /response_too_large/);
  assert.equal(cancelled, true, "the connection must be dropped, not drained");
});

test("a body exactly at the cap is accepted", async () => {
  const chunk = new Uint8Array(TEXT_MAX_BYTES);
  const bytes = await readCapped(bodyOf([chunk]), TEXT_MAX_BYTES);
  assert.equal(bytes.byteLength, TEXT_MAX_BYTES);
});

test("a lying Content-Length cannot get past the counter", async () => {
  // The caller never sees Content-Length here: only streamed bytes are counted.
  const chunk = new Uint8Array(512 * 1024);
  const body = bodyOf(new Array(20).fill(chunk));
  await assert.rejects(() => readCapped(body, TEXT_MAX_BYTES), /response_too_large/);
});

test("the error names the limit and the observed size, without the body", async () => {
  const chunk = new Uint8Array(TEXT_MAX_BYTES + 10);
  await assert.rejects(
    () => readCapped(bodyOf([chunk]), TEXT_MAX_BYTES),
    (err: unknown) => {
      const e = err as { limit?: number; bytes?: number };
      assert.equal(e.limit, TEXT_MAX_BYTES);
      assert.ok((e.bytes ?? 0) > TEXT_MAX_BYTES);
      assert.ok(!("body" in (err as object)) && !("text" in (err as object)));
      return true;
    },
  );
});

test("cap selection follows the media kind and content type", () => {
  assert.equal(capFor("text/html"), TEXT_MAX_BYTES);
  assert.equal(capFor("application/rss+xml"), TEXT_MAX_BYTES);
  assert.equal(capFor(""), TEXT_MAX_BYTES);
  assert.equal(capFor("image/jpeg"), MEDIA_MAX_BYTES);
  assert.equal(capFor("video/mp4"), MEDIA_MAX_BYTES);
  assert.equal(capFor("audio/mpeg"), MEDIA_MAX_BYTES);
  assert.equal(capFor("text/plain", "media"), MEDIA_MAX_BYTES);
});

// --- publicFetch: redirect handling, pinning, caps ------------------------

/** A transport double that records what it was asked for. */
function transportOf(responses: unknown[]) {
  const calls: { url: string; lookup: unknown }[] = [];
  const transport: OutboundTransport = async (url, options) => {
    calls.push({ url: url.href, lookup: options.lookup });
    const next = responses.shift();
    if (!next) throw new Error("transport exhausted");
    return next as Awaited<ReturnType<OutboundTransport>>;
  };
  return { transport, calls };
}

function textResponse(body: string | Uint8Array, status = 200, headers: Record<string, string> = {}): {
  status: number;
  headers: Record<string, string>;
  body: BodyLike;
} {
  return { status, headers: { "content-type": "text/plain", ...headers }, body: bodyOf([body]) };
}

test("a public fetch returns the decoded body", async () => {
  const { transport } = transportOf([textResponse("hello feed")]);
  const result = await publicFetch("https://example.com/feed.xml", {
    resolver: resolverFor({ "example.com": ["93.184.216.34"] }),
    transport,
  });
  assert.equal(result.text, "hello feed");
  assert.equal(result.url, "https://example.com/feed.xml");
});

test("a redirect to a private address is refused, not followed", async () => {
  const { transport, calls } = transportOf([
    { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" }, body: bodyOf([]) },
  ]);
  await assert.rejects(
    () => publicFetch("https://example.com/feed", {
      resolver: resolverFor({ "example.com": ["93.184.216.34"] }),
      transport,
    }),
    /blocked_address/,
  );
  assert.equal(calls.length, 1, "the private hop must never be requested");
});

test("a redirect to another public host is followed and re-validated", async () => {
  const { transport, calls } = transportOf([
    { status: 301, headers: { location: "https://cdn.example.net/feed.xml" }, body: bodyOf([]) },
    textResponse("redirected body"),
  ]);
  const result = await publicFetch("https://example.com/feed", {
    resolver: resolverFor({ "example.com": ["93.184.216.34"], "cdn.example.net": ["1.1.1.1"] }),
    transport,
  });
  assert.equal(result.text, "redirected body");
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, "https://cdn.example.net/feed.xml");
});

test("a relative redirect resolves against the current URL", async () => {
  const { transport, calls } = transportOf([
    { status: 302, headers: { location: "/moved/feed.xml" }, body: bodyOf([]) },
    textResponse("moved"),
  ]);
  await publicFetch("https://example.com/old/feed.xml", {
    resolver: resolverFor({ "example.com": ["93.184.216.34"] }),
    transport,
  });
  assert.equal(calls[1].url, "https://example.com/moved/feed.xml");
});

test("too many redirects is refused", async () => {
  const loop = Array.from({ length: 10 }, () => ({
    status: 302,
    headers: { location: "https://example.com/loop" },
    body: bodyOf([]),
  }));
  const { transport } = transportOf(loop);
  await assert.rejects(
    () => publicFetch("https://example.com/loop", {
      resolver: resolverFor({ "example.com": ["93.184.216.34"] }),
      transport,
      maxRedirects: 3,
    }),
    /too_many_redirects/,
  );
});

test("a redirect without a Location header is an error", async () => {
  const { transport } = transportOf([{ status: 302, headers: {}, body: bodyOf([]) }]);
  await assert.rejects(
    () => publicFetch("https://example.com/x", {
      resolver: resolverFor({ "example.com": ["93.184.216.34"] }),
      transport,
    }),
    /redirect_without_location/,
  );
});

test("the connection is pinned to the validated address, not a fresh lookup", async () => {
  // The resolver returns a public address; the lookup handed to the transport
  // must answer with exactly that, even if a later real lookup would differ.
  let captured: LookupHook | undefined;
  const { transport } = transportOf([textResponse("ok")]);
  const recording: OutboundTransport = async (url, options) => {
    captured = options.lookup;
    return transport(url, options);
  };
  await publicFetch("https://example.com/feed", {
    resolver: resolverFor({ "example.com": ["93.184.216.34"] }),
    transport: recording,
  });
  assert.ok(captured, "the transport must receive a lookup hook");
  const lookup = captured as LookupHook;
  const single = await new Promise<string>((resolve, reject) =>
    lookup("example.com", {}, (err: Error | null | undefined, address?: unknown) =>
      err ? reject(err) : resolve(address as string)));
  assert.equal(single, "93.184.216.34");

  const all = await new Promise<unknown>((resolve, reject) =>
    lookup("example.com", { all: true }, (err: Error | null | undefined, addresses?: unknown) =>
      err ? reject(err) : resolve(addresses)));
  assert.deepEqual(all, [{ address: "93.184.216.34", family: 4 }]);
});

test("a non-2xx response is an error carrying only the status", async () => {
  const { transport } = transportOf([{ status: 500, headers: {}, body: bodyOf(["secret-ish body"]) }]);
  await assert.rejects(
    () => publicFetch("https://example.com/x", {
      resolver: resolverFor({ "example.com": ["93.184.216.34"] }),
      transport,
    }),
    (err: unknown) => {
      const message = String((err as Error).message);
      assert.match(message, /HTTP 500/);
      assert.ok(!message.includes("secret-ish"));
      return true;
    },
  );
});

test("the configured cap is enforced through publicFetch", async () => {
  const { transport } = transportOf([textResponse(new Uint8Array(5000))]);
  await assert.rejects(
    () => publicFetch("https://example.com/big", {
      resolver: resolverFor({ "example.com": ["93.184.216.34"] }),
      transport,
      maxBytes: 1024,
    }),
    /response_too_large/,
  );
});

// --- T21-A: operator-declared egress ranges (fake-IP proxy hosts) ------------

import { parseEgressCidrs, addressAllowedByEgress, declaredEgress } from "./outbound-policy.ts";

test("the environment declaration is honoured, and read per call", () => {
  const saved = process.env.LOOM_EGRESS_CIDRS;
  try {
    delete process.env.LOOM_EGRESS_CIDRS;
    assert.deepEqual(declaredEgress(), [], "unset means no exception at all");
    process.env.LOOM_EGRESS_CIDRS = "198.18.0.0/15";
    assert.deepEqual(declaredEgress().length, 1, "set after import still takes effect");
  } finally {
    if (saved === undefined) delete process.env.LOOM_EGRESS_CIDRS;
    else process.env.LOOM_EGRESS_CIDRS = saved;
  }
});

test("no declared egress keeps the strict default (nothing changes)", () => {
  assert.deepEqual(parseEgressCidrs(undefined), []);
  assert.deepEqual(parseEgressCidrs(""), []);
  assert.equal(addressAllowedByEgress("198.18.0.201", []), false,
    "without an explicit declaration the synthetic range stays blocked");
});

test("a declared egress range unblocks exactly that range", () => {
  const cidrs = parseEgressCidrs("198.18.0.0/15");
  assert.equal(cidrs.length, 1);
  assert.equal(addressAllowedByEgress("198.18.0.201", cidrs), true);
  assert.equal(addressAllowedByEgress("198.19.255.254", cidrs), true);
  // Outside the declared range: still blocked.
  assert.equal(addressAllowedByEgress("198.20.0.1", cidrs), false);
  assert.equal(addressAllowedByEgress("10.0.0.1", cidrs), false);
});

test("loopback, metadata and multicast can never be declared as egress", () => {
  // A misconfiguration (or a hostile env var) must not turn these into egress.
  for (const declaration of ["127.0.0.0/8", "169.254.0.0/16", "224.0.0.0/4", "0.0.0.0/8"]) {
    const cidrs = parseEgressCidrs(declaration);
    assert.deepEqual(cidrs, [], `must refuse to honour: ${declaration}`);
  }
  // Even if a broader range would cover them, the address check stays closed.
  const wide = parseEgressCidrs("127.0.0.0/8,198.18.0.0/15");
  assert.equal(addressAllowedByEgress("127.0.0.1", wide), false, "loopback is never egress");
  assert.equal(addressAllowedByEgress("198.18.0.5", wide), true, "the legitimate range still works");
});

test("malformed declarations are ignored, not guessed at", () => {
  for (const bad of ["not-a-cidr", "198.18.0.0/33", "198.18.0.0/-1", "999.1.1.1/8", "198.18.0/15", ","]) {
    assert.deepEqual(parseEgressCidrs(bad), [], `must ignore: ${bad}`);
  }
  // A bare address is a legitimate /32-style single-host declaration.
  const single = parseEgressCidrs("198.18.0.7");
  assert.equal(single.length, 1);
  assert.equal(single[0].prefix, 32);
  assert.equal(addressAllowedByEgress("198.18.0.7", single), true);
  assert.equal(addressAllowedByEgress("198.18.0.8", single), false, "a single host is not a range");
  // A valid entry alongside a bad one keeps the valid one.
  const mixed = parseEgressCidrs("nonsense,198.18.0.0/15");
  assert.equal(mixed.length, 1);
  assert.equal(addressAllowedByEgress("198.18.1.1", mixed), true);
});

test("IPv6 egress ranges work the same way", () => {
  const cidrs = parseEgressCidrs("fd00::/8");
  assert.equal(addressAllowedByEgress("fd00::1", cidrs), true);
  assert.equal(addressAllowedByEgress("fe80::1", parseEgressCidrs("fe80::/10")), false,
    "link-local is never egress");
});
