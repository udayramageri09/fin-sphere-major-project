// Minimal black-and-white growth mark, recreated from the approved concept.
export default function BrandMark({ size = 32 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" fill="none" aria-hidden="true" focusable="false" className="shrink-0">
      <circle cx="20" cy="20" r="20" fill="#09090b" />
      <rect x="10" y="23" width="5" height="7" rx="1" fill="white" />
      <rect x="18" y="17" width="5" height="13" rx="1" fill="white" />
      <rect x="26" y="10" width="5" height="20" rx="1" fill="white" />
    </svg>
  );
}
