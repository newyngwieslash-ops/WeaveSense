import test from "node:test";
import assert from "node:assert/strict";
import { publicFetch, collectionFetch } from "./outbound-policy.ts";
const resolver = {
  async lookup() {
    return [{ address: "93.184.216.34", family: 4 }];
  },
};
const pause = () => new Promise<void>((r) => setImmediate(r));

test("public redirect hops and manual/internal requests retain host permits until bodies finish", async () => {
  let active = 0,
    peak = 0;
  const release: (() => void)[] = [];
  const body = () =>
    new ReadableStream<Uint8Array>({
      start(c) {
        active++;
        peak = Math.max(peak, active);
        release.push(() => {
          active--;
          c.close();
        });
      },
    });
  const transport = async (url: URL) =>
    url.hostname === "shared.example"
      ? { status: 200, headers: {}, body: body() }
      : {
          status: 302,
          headers: { location: "https://shared.example/data" },
          body: new ReadableStream<Uint8Array>({
            start(c) {
              c.close();
            },
          }),
        };
  const jobs = Array.from({ length: 5 }, (_, n) =>
    publicFetch(`https://origin${n}.example/`, { resolver, transport }),
  );
  jobs.push(
    collectionFetch(
      "https://shared.example/manual",
      { signal: AbortSignal.timeout(1000), redirect: "error" },
      async () => new Response(body()),
    )
      .then((r) => r.text())
      .then(() => ({ url: "", contentType: "", status: 200, headers: {} })),
  );
  for (let i = 0; i < 10; i++) await pause();
  assert.equal(active, 2);
  while (release.length || active) {
    release.splice(0).forEach((r) => r());
    for (let i = 0; i < 10; i++) await pause();
  }
  await Promise.all(jobs);
  assert.equal(peak, 2);
});
test("global cap is nine; queued deadlines, bad bodies and transport errors release permits", async () => {
  let active = 0,
    peak = 0;
  const releases: (() => void)[] = [];
  const transport = async () => ({
    status: 200,
    headers: {},
    body: new ReadableStream<Uint8Array>({
      start(c) {
        active++;
        peak = Math.max(active, peak);
        releases.push(() => {
          active--;
          c.close();
        });
      },
    }),
  });
  const jobs = Array.from({ length: 12 }, (_, n) =>
    publicFetch(`https://h${n}.example/`, { resolver, transport, timeoutMs: 2000 }),
  );
  for (let i = 0; i < 10; i++) await pause();
  assert.equal(active, 9);
  await assert.rejects(
    publicFetch("https://queued.example/", { resolver, transport, timeoutMs: 20 }),
    /timeout/,
  );
  while (releases.length || active) {
    releases.splice(0).forEach((r) => r());
    for (let i = 0; i < 10; i++) await pause();
  }
  await Promise.all(jobs);
  assert.equal(peak, 9);
  const broken = async () => ({
    status: 200,
    headers: {},
    body: new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array(5));
      },
      cancel() {
        return new Promise<void>(() => {});
      },
    }),
  });
  for (let n = 0; n < 4; n++)
    await assert.rejects(
      publicFetch("https://errors.example/", { resolver, transport: broken, maxBytes: 1 }),
      /response_too_large/,
    );
  for (let n = 0; n < 4; n++)
    await assert.rejects(
      publicFetch("https://errors.example/", {
        resolver,
        transport: async () => {
          throw new Error("broken");
        },
      }),
      /network_error/,
    );
  assert.equal(
    (
      await publicFetch("https://errors.example/", {
        resolver,
        transport: async () => ({
          status: 200,
          headers: {},
          body: new ReadableStream({
            start(c) {
              c.close();
            },
          }),
        }),
      })
    ).status,
    200,
  );
});

test("internal abandoned bodies and queued cancellation cannot wedge host admission", async () => {
  const controllers = [new AbortController(), new AbortController(), new AbortController()];
  let cancelled = 0,
    started = 0;
  const fake: typeof fetch = async () => {
    started++;
    return new Response(
      new ReadableStream({
        cancel() {
          cancelled++;
          return new Promise<void>(() => {});
        },
      }),
    );
  };
  const first = await collectionFetch(
    "https://internal.example/one",
    { signal: controllers[0].signal },
    fake,
  );
  const second = await collectionFetch(
    "https://internal.example/two",
    { signal: controllers[1].signal },
    fake,
  );
  const queued = collectionFetch(
    "https://internal.example/three",
    { signal: controllers[2].signal },
    fake,
  );
  const rejected = assert.rejects(queued);
  controllers[2].abort();
  await rejected;
  assert.equal(started, 2);
  controllers[0].abort();
  await second.body!.cancel();
  assert.equal(cancelled, 2);
  const final = await collectionFetch(
    "https://internal.example/final",
    { signal: AbortSignal.timeout(1000) },
    async () => new Response("ok"),
  );
  assert.equal(await final.text(), "ok");
  void first;
});
