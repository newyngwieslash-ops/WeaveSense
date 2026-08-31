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

export type WechatImportValue = {
  source_id: string;
  name: string;
  wechat_id: string;
  sample_url: string;
  primary_feed_url: string;
  interval_minutes: 60;
  priority: "normal" | "high";
};

export type WechatSourceInsert = {
  id: string;
  platform: "wechat";
  name: string;
  handle: string;
  url: string;
  feed_url: "";
  interval_minutes: 60;
  enabled: true;
  adapter: "wechat_gateway";
  notes: `priority:${"normal" | "high"}`;
  status: "idle";
};

export type WechatImportPreview = {
  rows: Array<{
    line: number;
    status: "valid" | "duplicate" | "error";
    errors: string[];
    input?: Readonly<{ name: string; wechat_id: string; priority: string }>;
    value?: WechatImportValue;
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
    const input = { name, wechat_id: wechatId, priority };

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
      preview.rows.push({ line: record.line, status: "error", errors, input });
      preview.error += 1;
    } else if (duplicateError) {
      preview.rows.push({ line: record.line, status: "duplicate", errors: [duplicateError], input });
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

const GATEWAY_IMPORT_ERRORS = new Set([
  "wechat_gateway_timeout",
  "wechat_gateway_unauthorized",
  "wechat_gateway_source_rejected",
  "wechat_gateway_http_error",
  "wechat_gateway_invalid_response",
  "wechat_gateway_response_too_large",
  "wechat_gateway_unavailable",
]);

function gatewayImportError(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  return GATEWAY_IMPORT_ERRORS.has(message) ? message : "wechat_gateway_unavailable";
}

export async function importWechatSources(
  input: { csv: string; confirmed_lines: number[] },
  dependencies: {
    existingWechatIds: ReadonlySet<string>;
    findExisting: (wechatId: string) => Promise<boolean>;
    putSource: (source: WechatImportValue) => Promise<unknown>;
    insertSource: (source: WechatSourceInsert) => Promise<unknown>;
  },
): Promise<{ created: number; skipped: number;
  failed: Array<{ line: number; name: string; error: string }> }> {
  if (typeof input?.csv !== "string" || !Array.isArray(input?.confirmed_lines) ||
    input.confirmed_lines.length > MAX_DATA_ROWS || input.confirmed_lines.some((line) =>
      !Number.isSafeInteger(line) || line < 2) ||
    new Set(input.confirmed_lines).size !== input.confirmed_lines.length ||
    Buffer.byteLength(input.csv, "utf8") > MAX_BYTES) {
    throw new Error("wechat_import_invalid_input");
  }
  const preview = previewWechatImport(input.csv, dependencies.existingWechatIds);
  if (preview.rows.length === 1 && preview.rows[0]?.line === 1 && preview.error === 1) {
    throw new Error("wechat_import_invalid_input");
  }
  const selected = new Set(input.confirmed_lines);
  const knownLines = new Set(preview.rows.map((row) => row.line));
  if ([...selected].some((line) => !knownLines.has(line))) {
    throw new Error("wechat_import_invalid_input");
  }

  const names = new Map(parseCsvRecords(input.csv).slice(1)
    .map((record) => [record.line, record.fields[0]?.trim() ?? ""]));
  let created = 0;
  let skipped = 0;
  const failed: Array<{ line: number; name: string; error: string }> = [];
  for (const row of preview.rows) {
    if (!selected.has(row.line)) continue;
    const name = row.value?.name ?? names.get(row.line) ?? "";
    if (row.status === "duplicate") {
      skipped += 1;
      continue;
    }
    if (row.status !== "valid" || !row.value) {
      failed.push({ line: row.line, name, error: row.errors.join("；") || "wechat_import_invalid_row" });
      continue;
    }

    let exists: boolean;
    try {
      exists = await dependencies.findExisting(row.value.wechat_id);
    } catch {
      failed.push({ line: row.line, name, error: "database_check_failed" });
      continue;
    }
    if (exists) {
      skipped += 1;
      continue;
    }
    try {
      await dependencies.putSource(row.value);
    } catch (error) {
      failed.push({ line: row.line, name, error: gatewayImportError(error) });
      continue;
    }

    const source: WechatSourceInsert = {
      id: row.value.source_id,
      platform: "wechat",
      name: row.value.name,
      handle: row.value.wechat_id,
      url: row.value.sample_url,
      feed_url: "",
      interval_minutes: 60,
      enabled: true,
      adapter: "wechat_gateway",
      notes: `priority:${row.value.priority}`,
      status: "idle",
    };
    try {
      await dependencies.insertSource(source);
      created += 1;
    } catch {
      try {
        if (await dependencies.findExisting(row.value.wechat_id)) {
          skipped += 1;
        } else {
          failed.push({ line: row.line, name, error: "database_insert_failed" });
        }
      } catch {
        failed.push({ line: row.line, name, error: "database_check_failed" });
      }
    }
  }
  return { created, skipped, failed };
}
