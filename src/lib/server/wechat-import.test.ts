import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseCsvRecords, previewWechatImport } from "./wechat-import.ts";

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
