import { z } from "zod";

export const subtitleLanguages = ["en", "zh-Hans", "zh-Hant"] as const;
export type SubtitleLanguage = typeof subtitleLanguages[number];
export const subtitleInput = z.object({
  id: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/),
  language: z.enum(subtitleLanguages).default("en"),
}).strict();
export function subtitleErrorCopy(code: unknown): string {
  switch (code) {
    case "subtitle_disabled": return "字幕读取尚未启用";
    case "subtitle_invalid_input": case "subtitle_unsupported": return "该条目或字幕语言不受支持";
    case "subtitle_conflict": return "正文或字幕已更新，请重新核对；已有字幕不会被覆盖";
    case "subtitle_busy": return "已有字幕读取任务，请稍后重试";
    case "subtitle_timeout": return "字幕读取超时，请稍后重试";
    case "subtitle_output_too_large": return "字幕超过大小限制，未保存";
    default: return "字幕节点暂不可用，请稍后重试";
  }
}
