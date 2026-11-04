import type { SVGProps } from "react";

/** Stupid's mark: a brain drawn in one loop, in Meta blue. */
export function Logo({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" aria-hidden className="logo">
      <defs>
      <linearGradient id="logo-fill" gradientUnits="userSpaceOnUse" x1="10" y1="10" x2="90" y2="92">
      <stop offset="0" stopColor="#4DB2FF"/>
      <stop offset=".5" stopColor="#0082FB"/>
      <stop offset="1" stopColor="#0058D6"/>
      </linearGradient>
      <clipPath id="logo-l"><rect x="0" y="0" width="47.5" height="100"/></clipPath>
      <clipPath id="logo-r"><rect x="52.5" y="0" width="47.5" height="100"/></clipPath>
      <g id="logo-lobes">
      <circle cx="37" cy="24" r="14"/><circle cx="22" cy="38" r="15"/><circle cx="17" cy="56" r="14"/>
      <circle cx="25" cy="72" r="14"/><circle cx="38" cy="80" r="12"/><rect x="30" y="20" width="20" height="66" rx="6"/>
      </g>
      <clipPath id="logo-brain">
      <circle cx="37" cy="24" r="14"/><circle cx="22" cy="38" r="15"/><circle cx="17" cy="56" r="14"/><circle cx="25" cy="72" r="14"/><circle cx="38" cy="80" r="12"/><rect x="30" y="20" width="20" height="66" rx="6"/><circle cx="63" cy="24" r="14"/><circle cx="78" cy="38" r="15"/><circle cx="83" cy="56" r="14"/><circle cx="75" cy="72" r="14"/><circle cx="62" cy="80" r="12"/><rect x="50" y="20" width="20" height="66" rx="6"/>
      </clipPath>
      </defs>
      <g fill="url(#logo-fill)">
      <g clipPath="url(#logo-l)"><use href="#logo-lobes"/></g>
      <g clipPath="url(#logo-r)"><use href="#logo-lobes" transform="matrix(-1 0 0 1 100 0)"/></g>
      </g>
      <path clipPath="url(#logo-brain)" fill="none" stroke="#fff" strokeWidth="4.6" strokeLinecap="round" strokeLinejoin="round"
      d="M0 44C9 54 22 57 32 52C40 48 41 39 35 37C28 35 23 44 25 53C27 63 36 67 44 64C51 61 53 54 55 48C58 41 63 38 69 40C76 42 78 50 74 56C70 62 62 63 58 58C55 54 57 49 62 49C71 50 86 58 100 72"/>
    </svg>
  );
}

// Nav glyphs on a 24px grid, 2px strokes (shapes after Lucide, ISC licence).
type Props = SVGProps<SVGSVGElement>;
function Glyph({ children, ...props }: Props) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>{children}</svg>;
}

export function TodayIcon(props: Props) {
  return <Glyph {...props}><path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8" /><path d="M3 10a2 2 0 0 1 .7-1.5l7-6a2 2 0 0 1 2.6 0l7 6A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></Glyph>;
}
export function InboxIcon(props: Props) {
  return <Glyph {...props}><path d="M22 12h-6l-2 3h-4l-2-3H2" /><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" /></Glyph>;
}
// The agent: a detective's hat and glasses, filled.
export function AgentsIcon(props: Props) {
  return <Glyph fill="currentColor" stroke="none" {...props}><path d="M5.4 3.7a.8.8 0 0 1 1-.6L12 4.6l5.6-1.5a.8.8 0 0 1 1 .6l1.6 7.6H3.8z" /><rect x="0.7" y="11.9" width="22.6" height="1.5" rx=".75" /><rect x="3" y="14.6" width="8.2" height="6.3" rx="1.6" /><rect x="12.8" y="14.6" width="8.2" height="6.3" rx="1.6" /><rect x="11" y="16.3" width="2" height="2.2" /></Glyph>;
}
export function SettingsIcon(props: Props) {
  return <Glyph {...props}><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" /><circle cx="12" cy="12" r="3" /></Glyph>;
}

/** A check that draws itself once, for a reply that went out. */
export const Check = () => <svg className="check" viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="m3 8.5 3.2 3L13 4.5" pathLength="1" /></svg>;
