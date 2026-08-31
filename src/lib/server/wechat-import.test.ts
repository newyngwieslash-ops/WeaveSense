import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  importWechatSources,
  parseCsvRecords,
  previewWechatImport,
  type WechatSourceInsert,
} from "./wechat-import.ts";

const HEADER = "name,wechat_id,sample_url,primary_feed_url,interval_minutes,priority";
const row = (
  name: string,
  id: string,
  priority = "",
  sampleUrl = `https://mp.weixin.qq.com/s/${id}`,
  feedUrl = `https://feeds.example.com/${id}.atom`,
  interval = "60",
) => `${name},${id},${sampleUrl},${feedUrl},${interval},${priority}`;

describe("parseCsvRecords", () => {
  it("parses BOM, CRLF, quoted commas, escaped quotes, and no final newline", () => {
    assert.deepEqual(
      parseCsvRecords(`\uFEFF${HEADER}\r\n"示例,公众号","gh_""quoted",https://mp.weixin.qq.com/s/a,https://feeds.example.com/a.atom,60,high`),
      [
        { line: 1, fields: HEADER.split(",") },
        {
          line: 2,
          fields: [
            "示例,公众号",
            'gh_"quoted',
            "https://mp.weixin.qq.com/s/a",
            "https://feeds.example.com/a.atom",
            "60",
            "high",
          ],
        },
      ],
    );
  });

  it("tracks the starting line of a multiline quoted record", () => {
    assert.deepEqual(parseCsvRecords('a,b\r\n"line 1\nline 2",c\r\nx,y'), [
      { line: 1, fields: ["a", "b"] },
      { line: 2, fields: ["line 1\nline 2", "c"] },
      { line: 4, fields: ["x", "y"] },
    ]);
  });

  it("rejects malformed quoting", () => {
    assert.throws(() => parseCsvRecords('a,"unterminated'), /CSV/);
    assert.throws(() => parseCsvRecords('a,"closed"tail'), /CSV/);
  });
});

describe("previewWechatImport", () => {
  it("requires the exact header", () => {
    const preview = previewWechatImport(`${HEADER.replace("name", "Name")}\n${row("示例", "gh_a")}`, new Set());
    assert.deepEqual(preview, {
      rows: [{ line: 1, status: "error", errors: ["CSV 表头不正确"] }],
      valid: 0,
      duplicate: 0,
      error: 1,
    });
  });

  it("normalizes fields and defaults a blank priority to normal", () => {
    const preview = previewWechatImport(`\uFEFF${HEADER}\r\n${row(
      " 示例号 ",
      " gh_example ",
      "",
      " https://mp.weixin.qq.com/s/gh_example ",
      " https://feeds.example.com/gh_example.atom ",
    )}\r\n`, new Set());
    assert.equal(preview.valid, 1);
    assert.equal(preview.duplicate, 0);
    assert.equal(preview.error, 0);
    assert.deepEqual(preview.rows[0], {
      line: 2,
      status: "valid",
      errors: [],
      value: {
        source_id: preview.rows[0]?.value?.source_id,
        name: "示例号",
        wechat_id: "gh_example",
        sample_url: "https://mp.weixin.qq.com/s/gh_example",
        primary_feed_url: "https://feeds.example.com/gh_example.atom",
        interval_minutes: 60,
        priority: "normal",
      },
    });
    assert.match(preview.rows[0]?.value?.source_id ?? "", /^wx-[a-f0-9]{20}$/);

    const high = previewWechatImport(
      `${HEADER}\n${row("高优先级", "gh_high", "high", undefined, "http://feeds.example.com/high.atom")}`,
      new Set(),
    );
    assert.equal(high.rows[0]?.status, "valid");
    assert.equal(high.rows[0]?.value?.priority, "high");
  });

  it("reports required fields per row", () => {
    const csv = [HEADER,
      row("", "gh_no_name"),
      row("无微信号", ""),
      row("无样例", "gh_no_sample", "", ""),
      row("无订阅", "gh_no_feed", "", undefined, ""),
    ].join("\n");
    const preview = previewWechatImport(csv, new Set());
    assert.equal(preview.error, 4);
    assert.deepEqual(preview.rows.map((entry) => entry.errors), [
      ["name 不能为空"],
      ["wechat_id 不能为空"],
      ["sample_url 不能为空"],
      ["primary_feed_url 不能为空"],
    ]);
  });

  it("rejects invalid URLs, interval, priority, and field count", () => {
    const csv = [HEADER,
      row("外站样例", "gh_sample", "", "https://example.com/a"),
      row("样例含凭据", "gh_sample_credentials", "", "https://evil.example@mp.weixin.qq.com/s/a"),
      row("错误订阅协议", "gh_feed", "", undefined, "ftp://feeds.example.com/a"),
      row("订阅含凭据", "gh_feed_credentials", "", undefined, "https://user:pass@feeds.example.com/a"),
      row("错误间隔", "gh_interval", "", undefined, undefined, "30"),
      row("错误优先级", "gh_priority", "urgent"),
      `${row("字段过多", "gh_extra")},extra`,
    ].join("\n");
    const preview = previewWechatImport(csv, new Set());
    assert.equal(preview.error, 7);
    assert.deepEqual(preview.rows.map((entry) => entry.errors), [
      ["sample_url 必须是 mp.weixin.qq.com 的 HTTPS 链接"],
      ["sample_url 必须是 mp.weixin.qq.com 的 HTTPS 链接"],
      ["primary_feed_url 必须是 HTTP 或 HTTPS 链接"],
      ["primary_feed_url 必须是 HTTP 或 HTTPS 链接"],
      ["interval_minutes 必须为 60"],
      ["priority 必须为 normal 或 high"],
      ["字段数量必须为 6"],
    ]);
  });

  it("marks duplicate WeChat ids in the CSV and existing sources case-insensitively", () => {
    const preview = previewWechatImport([
      HEADER,
      row("首行", "GH_FIRST"),
      row("文件内重复", " gh_first "),
      row("已存在", "Gh_Existing"),
    ].join("\n"), new Set(["gh_existing"]));
    assert.deepEqual(preview.rows.map(({ line, status, errors }) => ({ line, status, errors })), [
      { line: 2, status: "valid", errors: [] },
      { line: 3, status: "duplicate", errors: ["wechat_id 在 CSV 中重复"] },
      { line: 4, status: "duplicate", errors: ["wechat_id 已存在"] },
    ]);
    assert.deepEqual({ valid: preview.valid, duplicate: preview.duplicate, error: preview.error },
      { valid: 1, duplicate: 2, error: 0 });
  });

  it("does not let an invalid row consume the CSV duplicate slot", () => {
    const preview = previewWechatImport([
      HEADER,
      row("无效首行", "GH_RETRY", "", "https://example.com/not-wechat"),
      row("有效重试", "gh_retry"),
      row("已存在", "GH_EXISTING"),
    ].join("\n"), new Set(["gh_existing"]));
    assert.deepEqual(preview.rows.map(({ status, errors }) => ({ status, errors })), [
      { status: "error", errors: ["sample_url 必须是 mp.weixin.qq.com 的 HTTPS 链接"] },
      { status: "valid", errors: [] },
      { status: "duplicate", errors: ["wechat_id 已存在"] },
    ]);
    assert.deepEqual({ valid: preview.valid, duplicate: preview.duplicate, error: preview.error },
      { valid: 1, duplicate: 1, error: 1 });
  });

  it("keeps normalized display fields for quoted duplicate and invalid rows", () => {
    const preview = previewWechatImport([
      HEADER,
      row("首行", "gh_first"),
      '" 文件内,重复 "," GH_FIRST ",https://mp.weixin.qq.com/s/duplicate,https://feeds.example.com/duplicate.atom,60,high',
      '" 无效,链接 "," GH_INVALID ",https://example.com/not-wechat,https://feeds.example.com/invalid.atom,60,',
    ].join("\n"), new Set());
    assert.deepEqual(preview.rows.slice(1), [
      {
        line: 3,
        status: "duplicate",
        errors: ["wechat_id 在 CSV 中重复"],
        input: { name: "文件内,重复", wechat_id: "GH_FIRST", priority: "high" },
      },
      {
        line: 4,
        status: "error",
        errors: ["sample_url 必须是 mp.weixin.qq.com 的 HTTPS 链接"],
        input: { name: "无效,链接", wechat_id: "GH_INVALID", priority: "normal" },
      },
    ]);
  });

  it("previews 500 valid rows", () => {
    const csv = [HEADER, ...Array.from({ length: 500 }, (_, index) => row(`公众号${index}`, `gh_${index}`))].join("\n");
    const preview = previewWechatImport(csv, new Set());
    assert.deepEqual({ rows: preview.rows.length, valid: preview.valid, duplicate: preview.duplicate, error: preview.error },
      { rows: 500, valid: 500, duplicate: 0, error: 0 });
  });

  it("rejects input above 1 MiB before parsing", () => {
    const preview = previewWechatImport(`${HEADER}\n${"x".repeat(1024 * 1024)}`, new Set());
    assert.deepEqual(preview, {
      rows: [{ line: 1, status: "error", errors: ["CSV 文件不能超过 1 MiB"] }],
      valid: 0,
      duplicate: 0,
      error: 1,
    });
  });

  it("accepts 1,000 data rows and rejects 1,001", () => {
    const rows = Array.from({ length: 1_001 }, (_, index) => row(`公众号${index}`, `gh_${index}`));
    assert.equal(previewWechatImport([HEADER, ...rows.slice(0, 1_000)].join("\n"), new Set()).valid, 1_000);
    assert.deepEqual(previewWechatImport([HEADER, ...rows].join("\n"), new Set()), {
      rows: [{ line: 1, status: "error", errors: ["CSV 数据行不能超过 1000 行"] }],
      valid: 0,
      duplicate: 0,
      error: 1,
    });
  });
});

describe("importWechatSources", () => {
  it("rejects malformed core inputs before dependencies run", async () => {
    const csv = `${HEADER}\n${row("示例", "gh_example")}`;
    const invalid = [
      { csv: 1, confirmed_lines: [] },
      { csv, confirmed_lines: [1] },
      { csv, confirmed_lines: [2, 2] },
      { csv, confirmed_lines: Array.from({ length: 1_001 }, (_, index) => index + 2) },
      { csv: `${HEADER}\n${"x".repeat(1024 * 1024)}`, confirmed_lines: [] },
      { csv: "wrong,header", confirmed_lines: [] },
    ];
    let calls = 0;
    const dependencies = {
      existingWechatIds: new Set<string>(),
      findExisting: async () => { calls += 1; return false; },
      putSource: async () => { calls += 1; },
      insertSource: async () => { calls += 1; },
    };
    for (const input of invalid) {
      await assert.rejects(importWechatSources(
        input as { csv: string; confirmed_lines: number[] }, dependencies),
      /wechat_import_invalid_input/);
    }
    assert.equal(calls, 0);
  });

  it("rejects confirmed lines that do not exist before any side effect", async () => {
    let calls = 0;
    await assert.rejects(importWechatSources({
      csv: `${HEADER}\n${row("示例", "gh_example")}`,
      confirmed_lines: [99],
    }, {
      existingWechatIds: new Set(),
      findExisting: async () => { calls += 1; return false; },
      putSource: async () => { calls += 1; },
      insertSource: async () => { calls += 1; },
    }), /wechat_import_invalid_input/);
    assert.equal(calls, 0);
  });

  it("revalidates selected rows and continues through every sanitized per-row failure", async () => {
    const ids = ["create", "initial", "invalid", "db_dup", "db_error", "gateway_error",
      "gateway_timeout", "insert_error", "race", "secondary_error", "after", "unselected"];
    const csv = [HEADER, ...ids.map((id) => row(`名称-${id}`, `gh_${id}`, "",
      id === "invalid" ? "https://example.com/not-wechat" : undefined))].join("\n");
    const selected = ids.slice(0, -1).map((_id, index) => index + 2);
    const checks = new Map<string, number>();
    const events: string[] = [];
    const inserted: WechatSourceInsert[] = [];
    const result = await importWechatSources({ csv, confirmed_lines: selected }, {
      existingWechatIds: new Set(["GH_INITIAL"]),
      findExisting: async (wechatId) => {
        const id = wechatId.toLowerCase();
        const count = (checks.get(id) ?? 0) + 1;
        checks.set(id, count);
        events.push(`check:${id}:${count}`);
        if (id === "gh_db_error") throw new Error("secret-db-check");
        if (id === "gh_secondary_error" && count === 2) throw new Error("secret-secondary-check");
        return id === "gh_db_dup" || (id === "gh_race" && count === 2);
      },
      putSource: async (source) => {
        events.push(`gateway:${source.wechat_id.toLowerCase()}:${source.source_id}`);
        if (source.wechat_id.toLowerCase() === "gh_gateway_error") throw new Error("secret-token");
        if (source.wechat_id.toLowerCase() === "gh_gateway_timeout") {
          throw new Error("wechat_gateway_timeout");
        }
      },
      insertSource: async (source) => {
        events.push(`insert:${source.handle.toLowerCase()}:${source.id}`);
        if (["gh_insert_error", "gh_race", "gh_secondary_error"].includes(source.handle.toLowerCase())) {
          throw new Error("secret-insert");
        }
        inserted.push(source);
      },
    });

    assert.deepEqual(result, {
      created: 2,
      skipped: 3,
      failed: [
        { line: 4, name: "名称-invalid", error: "sample_url 必须是 mp.weixin.qq.com 的 HTTPS 链接" },
        { line: 6, name: "名称-db_error", error: "database_check_failed" },
        { line: 7, name: "名称-gateway_error", error: "wechat_gateway_unavailable" },
        { line: 8, name: "名称-gateway_timeout", error: "wechat_gateway_timeout" },
        { line: 9, name: "名称-insert_error", error: "database_insert_failed" },
        { line: 11, name: "名称-secondary_error", error: "database_check_failed" },
      ],
    });
    assert.deepEqual(inserted, [
      {
        id: inserted[0]?.id,
        platform: "wechat",
        name: "名称-create",
        handle: "gh_create",
        url: "https://mp.weixin.qq.com/s/gh_create",
        feed_url: "",
        interval_minutes: 60,
        enabled: true,
        adapter: "wechat_gateway",
        notes: "priority:normal",
        status: "idle",
      },
      {
        id: inserted[1]?.id,
        platform: "wechat",
        name: "名称-after",
        handle: "gh_after",
        url: "https://mp.weixin.qq.com/s/gh_after",
        feed_url: "",
        interval_minutes: 60,
        enabled: true,
        adapter: "wechat_gateway",
        notes: "priority:normal",
        status: "idle",
      },
    ]);
    assert.match(inserted[0]?.id ?? "", /^wx-[a-f0-9]{20}$/);
    assert.ok(events.indexOf(`gateway:gh_create:${inserted[0]?.id}`) <
      events.indexOf(`insert:gh_create:${inserted[0]?.id}`));
    assert.ok(!events.some((event) => event.includes("gh_unselected")));
    assert.doesNotMatch(JSON.stringify(result), /secret/);
  });

  it("retries a gateway-success/database-failure with the same deterministic source id", async () => {
    const csv = `${HEADER}\n${row("重试号", "GH_RETRY")}`;
    const gatewayIds: string[] = [];
    let inserts = 0;
    const dependencies = {
      existingWechatIds: new Set<string>(),
      findExisting: async () => false,
      putSource: async (source: { source_id: string }) => { gatewayIds.push(source.source_id); },
      insertSource: async () => {
        inserts += 1;
        if (inserts === 1) throw new Error("database unavailable");
      },
    };
    const first = await importWechatSources({ csv, confirmed_lines: [2] }, dependencies);
    const second = await importWechatSources({ csv, confirmed_lines: [2] }, dependencies);
    assert.deepEqual(first, { created: 0, skipped: 0,
      failed: [{ line: 2, name: "重试号", error: "database_insert_failed" }] });
    assert.deepEqual(second, { created: 1, skipped: 0, failed: [] });
    assert.equal(gatewayIds.length, 2);
    assert.equal(gatewayIds[0], gatewayIds[1]);
  });
});
