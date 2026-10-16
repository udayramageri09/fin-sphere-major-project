// A sphere for the whole financial picture, with a rising stroke for progress.
export default function BrandMark({ size = 32 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" fill="none" aria-hidden="true" focusable="false" className="shrink-0">
      <rect width="40" height="40" rx="12" fill="#09090b" />
      <circle cx="20" cy="20" r="12" stroke="white" strokeWidth="1.5" />
      <path d="M14 27V14h12M14 20h9" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="m23 27 7-7" stroke="white" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
