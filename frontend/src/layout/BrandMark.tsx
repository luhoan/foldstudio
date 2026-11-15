/**
 * The FoldStudio mark: a helix drawn the way ribbon diagrams draw one, side-on, with the near
 * strands heavy and the far strands light. Same drawing as public/favicon.svg.
 */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden className={className} fill="none" strokeLinecap="round" strokeLinejoin="round">
      <path d="M11.5 9.5C12.6 14 12.9 18 14 22.5M19.5 9.5C20.6 14 20.9 18 22 22.5" stroke="currentColor" strokeOpacity="0.45" strokeWidth="2" />
      <path d="M6 22.5C8.2 18.5 9.3 13.5 11.5 9.5M14 22.5C16.2 18.5 17.3 13.5 19.5 9.5M22 22.5C24.2 18.5 25.3 13.5 27.5 9.5" stroke="currentColor" strokeWidth="3.2" />
    </svg>
  )
}
