export function CalendarBaseIcon({ children }: { children?: React.ReactNode }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="2" y="3" width="12" height="11" rx="1" />
      <line x1="2" y1="7" x2="14" y2="7" />
      <line x1="5" y1="1" x2="5" y2="4" />
      <line x1="11" y1="1" x2="11" y2="4" />
      {children}
    </svg>
  );
}

export function CalendarLetter({ letter }: { letter: string }) {
  return (
    <text
      x="8"
      y="12.5"
      textAnchor="middle"
      fontSize="6"
      fontWeight="700"
      fill="currentColor"
      stroke="none"
    >
      {letter}
    </text>
  );
}
