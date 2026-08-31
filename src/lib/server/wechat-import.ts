import { normalizeWechatUrl, wechatSourceId } from "../wechat-canonical.ts";

const HEADER = [
  "name",
  "wechat_id",
  "sample_url",
  "primary_feed_url",
  "interval_minutes",
  "priority",
];
const MAX_BYTES = 1024 * 1024;
const MAX_DATA_ROWS = 1_000;

export type CsvRecord = { line: number; fields: string[] };

export type WechatImportPreview = {
  rows: Array<{
    line: number;
    status: "valid" | "duplicate" | "error";
    errors: string[];
    value?: {
      source_id: string;
      name: string;
      wechat_id: string;
      sample_url: string;
      primary_feed_url: string;
      interval_minutes: 60;
      priority: "normal" | "high";
    };
  }>;
  valid: number;
  duplicate: number;
  error: number;
};

export function parseCsvRecords(input: string): CsvRecord[] {
  const text = input.startsWith("\uFEFF") ? input.slice(1) : input;
  if (!text) return [];

  type State = "field" | "quoted field" | "quote-after-quote" | "record end";
  let state: State = "field";
  let field = "";
  let fields: string[] = [];
  let line = 1;
  let recordLine = 1;
  let endedWithCr = false;
  const records: CsvRecord[] = [];

  const endRecord = () => {
    fields.push(field);
    records.push({ line: recordLine, fields });
    field = "";
    fields = [];
  };

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (state === "record end") {
      if (endedWithCr && char === "\n") {
        endedWithCr = false;
        recordLine = line;
        continue;
      }
      endedWithCr = false;
      state = "field";
      recordLine = line;
      index -= 1;
      continue;
    }

    if (state === "field") {
      if (char === ",") {
        fields.push(field);
        field = "";
      } else if (char === '"') {
        if (field) throw new Error(`CSV 格式错误（第 ${line} 行）`);
        state = "quoted field";
      } else if (char === "\r" || char === "\n") {
        endRecord();
        line += 1;
        endedWithCr = char === "\r";
        state = "record end";
      } else {
        field += char;
      }
      continue;
    }

    if (state === "quoted field") {
      if (char === '"') {
        state = "quote-after-quote";
      } else {
        field += char;
        if (char === "\n" || (char === "\r" && text[index + 1] !== "\n")) line += 1;
      }
      continue;
    }

    if (char === '"') {
      field += '"';
      state = "quoted field";
    } else if (char === ",") {
      fields.push(field);
      field = "";
      state = "field";
    } else if (char === "\r" || char === "\n") {
      endRecord();
      line += 1;
      endedWithCr = char === "\r";
      state = "record end";
    } else {
      throw new Error(`CSV 格式错误（第 ${line} 行）`);
    }
  }

  if (state === "quoted field") throw new Error(`CSV 格式错误（第 ${line} 行）`);
  if (state !== "record end") endRecord();
  return records;
}

function globalError(message: string): WechatImportPreview {
  return {
    rows: [{ line: 1, status: "error", errors: [message] }],
    valid: 0,
    duplicate: 0,
    error: 1,
  };
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && Boolean(url.hostname) &&
      !url.username && !url.password;
  } catch {
    return false;
  }
}

export function previewWechatImport(
  csv: string,
  existingWechatIds: ReadonlySet<string>,
): WechatImportPreview {
  if (Buffer.byteLength(csv, "utf8") > MAX_BYTES) return globalError("CSV 文件不能超过 1 MiB");

  let records: CsvRecord[];
  try {
    records = parseCsvRecords(csv);
  } catch {
    return globalError("CSV 格式错误");
  }
  if (!records[0] || records[0].fields.length !== HEADER.length ||
    records[0].fields.some((field, index) => field !== HEADER[index])) {
    return globalError("CSV 表头不正确");
  }

  const data = records.slice(1);
  // ponytail: this in-memory ceiling stays simple; switch to streaming CSV parsing above 1 MiB/1,000 rows.
  if (data.length > MAX_DATA_ROWS) return globalError("CSV 数据行不能超过 1000 行");

  const existing = new Set([...existingWechatIds].map((id) => id.trim().toLowerCase()));
  const seen = new Set<string>();
  const preview: WechatImportPreview = { rows: [], valid: 0, duplicate: 0, error: 0 };

  for (const record of data) {
    const errors: string[] = [];
    if (record.fields.length !== HEADER.length) {
      errors.push("字段数量必须为 6");
    }
    const [rawName = "", rawWechatId = "", rawSampleUrl = "", rawFeedUrl = "",
      rawInterval = "", rawPriority = ""] = record.fields;
    const name = rawName.trim();
    const wechatId = rawWechatId.trim();
    const normalizedId = wechatId.toLowerCase();
    const sampleUrl = rawSampleUrl.trim();
    const primaryFeedUrl = rawFeedUrl.trim();
    const interval = rawInterval.trim();
    const priority = rawPriority.trim() || "normal";

    if (!name) errors.push("name 不能为空");
    if (!wechatId) errors.push("wechat_id 不能为空");
    if (!sampleUrl) {
      errors.push("sample_url 不能为空");
    } else {
      try {
        normalizeWechatUrl(sampleUrl);
      } catch {
        errors.push("sample_url 必须是 mp.weixin.qq.com 的 HTTPS 链接");
      }
    }
    if (!primaryFeedUrl) {
      errors.push("primary_feed_url 不能为空");
    } else if (!isHttpUrl(primaryFeedUrl)) {
      errors.push("primary_feed_url 必须是 HTTP 或 HTTPS 链接");
    }
    if (interval !== "60") errors.push("interval_minutes 必须为 60");
    if (priority !== "normal" && priority !== "high") errors.push("priority 必须为 normal 或 high");

    let duplicateError = "";
    if (errors.length === 0 && normalizedId) {
      duplicateError = existing.has(normalizedId)
        ? "wechat_id 已存在"
        : seen.has(normalizedId) ? "wechat_id 在 CSV 中重复" : "";
      seen.add(normalizedId);
    }

    if (errors.length > 0) {
      preview.rows.push({ line: record.line, status: "error", errors });
      preview.error += 1;
    } else if (duplicateError) {
      preview.rows.push({ line: record.line, status: "duplicate", errors: [duplicateError] });
      preview.duplicate += 1;
    } else {
      preview.rows.push({
        line: record.line,
        status: "valid",
        errors: [],
        value: {
          source_id: wechatSourceId(wechatId),
          name,
          wechat_id: wechatId,
          sample_url: sampleUrl,
          primary_feed_url: primaryFeedUrl,
          interval_minutes: 60,
          priority: priority as "normal" | "high",
        },
      });
      preview.valid += 1;
    }
  }
  return preview;
}
