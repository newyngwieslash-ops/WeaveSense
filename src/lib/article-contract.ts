import { z } from "zod";

export const articleAdoptInput = z.object({
  id: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  material_version: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict();
export const articlePreviewInput = articleAdoptInput.pick({ id: true });
export const articleRestoreInput = articleAdoptInput.pick({ id: true, material_version: true });

export function articleErrorCopy(code: unknown): string {
  switch (code) {
    case "article_invalid_id": case "article_invalid_input": return "原文操作参数无效";
    case "article_conflict": case "article_candidate_stale": return "内容已更新，请重新读取后采用";
    case "article_disabled": return "原文读取尚未配置";
    case "article_busy": return "已有原文读取任务，请稍后重试";
    case "article_not_found": return "找不到这条内容";
    case "article_wechat_gateway_required": return "微信正文请通过已配置的网关读取";
    case "article_unsupported": return "该内容不支持原文读取";
    case "article_target_not_allowed": return "该来源尚未开放原文读取";
    case "article_already_complete": return "当前正文已完整";
    case "article_restore_unavailable": return "暂无可恢复的此前正文";
    case "article_timeout": return "读取超时，请稍后重试";
    default: return "原文操作失败，请稍后重试";
  }
}
