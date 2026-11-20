export function Logo({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <rect x="1" y="3" width="22" height="18" rx="5" fill="#2f7bff" />
      <circle cx="8.5" cy="11" r="2.4" fill="#101216" />
      <circle cx="15.5" cy="11" r="2.4" fill="#101216" />
      <rect x="8" y="15.5" width="8" height="1.6" rx="0.8" fill="#101216" opacity="0.7" />
    </svg>
  )
}
