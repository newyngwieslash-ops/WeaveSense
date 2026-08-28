export function LoomMark({ className = "size-7" }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden="true">
      <rect x="3" y="3" width="11" height="11" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <rect x="18" y="3" width="11" height="11" rx="1.5" fill="currentColor" opacity="0.88" />
      <rect x="3" y="18" width="11" height="11" rx="1.5" fill="currentColor" opacity="0.55" />
      <rect x="18" y="18" width="11" height="11" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}
