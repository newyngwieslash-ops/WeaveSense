/**
 * Media kind classification, in its own module so it can be unit-tested without
 * importing the database layer (`media.ts` pulls in `@/lib/db`).
 */

/**
 * Classify a media URL by its *file*, falling back to the entry's declared
 * `mediaType` only when the extension says nothing.
 *
 * T12: the declared shape describes the item, not the file. A B 站 "video" entry
 * carries a JPEG cover as its only media, so classifying by `mediaType` first
 * filed the cover as a video — and the extraction step then handed a still image
 * to a paid speech-to-text call. The same ordering bug misfiled an `.mp3` on a
 * video entry.
 *
 * Order is therefore the point of this function:
 *   1. a recognised media extension wins (it describes the actual bytes);
 *   2. otherwise the declared kind is used as a hint;
 *   3. otherwise "file".
 */
export function guessKind(url: string, mediaType: string): string {
  const u = String(url ?? "").toLowerCase();
  if (/\.(jpg|jpeg|png|gif|webp|bmp|avif|heic)(\?|#|$)/.test(u)) return "image";
  if (/\.(mp4|mov|webm|mkv|m4v|avi)(\?|#|$)/.test(u)) return "video";
  if (/\.(mp3|wav|m4a|aac|ogg|opus|flac)(\?|#|$)/.test(u)) return "audio";
  if (/\.(pdf|docx?|xlsx?|pptx?|txt|md|csv|zip)(\?|#|$)/.test(u)) return "file";
  if (mediaType === "image" || mediaType === "video" || mediaType === "audio") return mediaType;
  return "file";
}
