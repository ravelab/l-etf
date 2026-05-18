"use client";

export function SortButton({
  label,
  active,
  dir,
  onClick,
}: {
  label: string;
  active: boolean;
  dir: "asc" | "desc";
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 ${
        active ? "text-foreground" : "text-muted"
      } hover:text-foreground transition-colors group`}
    >
      <span>{label}</span>
      <span className="flex flex-col -space-y-1">
        <svg
          width="8"
          height="8"
          viewBox="0 0 24 24"
          fill="currentColor"
          className={`${
            active && dir === "asc" ? "text-foreground" : "text-muted/30"
          }`}
        >
          <path d="M12 4L4 16H20L12 4Z" />
        </svg>
        <svg
          width="8"
          height="8"
          viewBox="0 0 24 24"
          fill="currentColor"
          className={`${
            active && dir === "desc" ? "text-foreground" : "text-muted/30"
          }`}
        >
          <path d="M12 20L20 8H4L12 20Z" />
        </svg>
      </span>
    </button>
  );
}
