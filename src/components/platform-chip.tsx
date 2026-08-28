import { PLATFORMS, type PlatformId } from "@/lib/platforms";
import { cn } from "@/lib/utils";

export function PlatformChip({
  platform,
  className,
}: {
  platform: PlatformId;
  className?: string;
}) {
  const def = PLATFORMS[platform];
  const Icon = def.icon;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full bg-raised px-2 py-0.5 text-[11px] text-muted",
        className,
      )}
    >
      <Icon className="size-3" strokeWidth={1.75} />
      {def.name}
    </span>
  );
}
