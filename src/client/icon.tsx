/**
 * The claude-mem glyph: Lucide's "brain" (ISC), drawn in `currentColor` so
 * whichever surface hosts it supplies the selected and hover colours.
 *
 * It lives in its own module because two surfaces draw it — the rail row and
 * the panel's page header — and `panel.tsx` importing it back from
 * `sidebar.tsx` would close a module cycle, since sidebar already imports
 * panel.
 * @module dsh-claude-mem/client/icon
 */

/** Edge length the shell asks its rail rows for. */
const GLYPH_SIZE = 18

/** Props a host passes a glyph: its own edge length and selected state. */
export interface PanelGlyphProps {
  readonly size?: number
  readonly active?: boolean
}

/**
 * The glyph: Lucide's "brain", drawn in `currentColor` so the host's selected
 * and hover colours come through untouched.
 * @param props - the host's glyph share.
 * @returns an 18×18 brain outline.
 */
export function ClaudeMemIcon({ size = GLYPH_SIZE }: PanelGlyphProps): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.9}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M12 18V5" />
      <path d="M15 13a4.17 4.17 0 0 1-3-4 4.17 4.17 0 0 1-3 4" />
      <path d="M17.707 6.294A3 3 0 1 0 12 5a3 3 0 1 0-5.707 1.294" />
      <path d="M17.996 5.125a4 4 0 0 1 2.526 5.77" />
      <path d="M18 18a4 4 0 0 0 2-7.465" />
      <path d="M19.967 17.482a4 4 0 1 1-7.967.517 4 4 0 1 1-7.967-.517" />
      <path d="M6 18a4 4 0 0 1-2-7.465" />
      <path d="M6.004 5.125a4 4 0 0 0-2.526 5.77" />
    </svg>
  )
}
