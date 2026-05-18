import { CalendarBaseIcon, CalendarLetter } from "./CalendarBaseIcon";

export function CalendarShortcutIcon({ letter }: { letter?: string } = {}) {
  return (
    <CalendarBaseIcon>
      {letter ? (
        <CalendarLetter letter={letter} />
      ) : (
        <>
          <polyline points="6,10.5 9,10.5" />
          <polyline points="7,9 9,10.5 7,12" />
        </>
      )}
    </CalendarBaseIcon>
  );
}
