/**
 * Inline glyphs mirroring the controls people actually tap while installing the
 * app. They exist so the walkthrough can show the button rather than describe
 * it; the project has no icon dependency, so these are hand-rolled.
 */

type IconProps = { className?: string };

const BASE = "h-[18px] w-[18px] shrink-0";

/** iOS Share — the square with an arrow leaving the top. */
export function ShareIcon({ className = "" }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={`${BASE} ${className}`}>
      <path d="M12 15V3" />
      <path d="m8 7 4-4 4 4" />
      <path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7" />
    </svg>
  );
}

/** "Add to Home Screen" — a square with a plus inside. */
export function AddToHomeIcon({ className = "" }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={`${BASE} ${className}`}>
      <rect x="3.5" y="3.5" width="17" height="17" rx="4" />
      <path d="M12 8.5v7M8.5 12h7" />
    </svg>
  );
}

/** Android overflow menu — the vertical three-dot "kebab". */
export function KebabMenuIcon({ className = "" }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={`${BASE} ${className}`}>
      <circle cx="12" cy="5" r="1.7" />
      <circle cx="12" cy="12" r="1.7" />
      <circle cx="12" cy="19" r="1.7" />
    </svg>
  );
}

export function CheckIcon({ className = "" }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={`${BASE} ${className}`}>
      <path d="m4 12.5 5 5L20 6.5" />
    </svg>
  );
}

export function ChevronRightIcon({ className = "" }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
      className={`h-4 w-4 shrink-0 ${className}`}>
      <path d="m9 5 7 7-7 7" />
    </svg>
  );
}

/** iOS share sheet — the chevron that opens the rest of the actions ("View More"). */
export function ChevronDownIcon({ className = "" }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={`${BASE} ${className}`}>
      <path d="m5 9 7 7 7-7" />
    </svg>
  );
}

/** A browser window — "open this in Chrome or Edge". */
export function BrowserWindowIcon({ className = "" }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={`${BASE} ${className}`}>
      <rect x="2.5" y="4" width="19" height="16" rx="2.5" />
      <path d="M2.5 9h19" />
      <circle cx="6" cy="6.5" r=".9" fill="currentColor" stroke="none" />
      <circle cx="9" cy="6.5" r=".9" fill="currentColor" stroke="none" />
    </svg>
  );
}

/**
 * The tune/sliders control at the left of Chrome's address bar, where a site's
 * notification permission is reset. This is the one step that matters to anyone
 * who dismissed or blocked the prompt: the button below goes quiet afterwards
 * and there is nothing on the page to say why.
 */
export function SlidersIcon({ className = "" }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={`${BASE} ${className}`}>
      <path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
      <circle cx="16" cy="7" r="2.2" />
      <circle cx="10" cy="17" r="2.2" />
    </svg>
  );
}

export function BellIcon({ className = "" }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={`${BASE} ${className}`}>
      <path d="M18 8a6 6 0 1 0-12 0c0 6-2 7-2 7h16s-2-1-2-7" />
      <path d="M10.5 20a2 2 0 0 0 3 0" />
    </svg>
  );
}
