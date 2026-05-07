export function MenuItem({
  icon = "◇",
  label,
  active,
  badge,
  badgeKind,
  onClick,
}: {
  icon?: string;
  label: string;
  active?: boolean;
  badge?: string;
  badgeKind?: "live";
  onClick?: () => void;
}) {
  return (
    <button
      className={"sb-item" + (active ? " active" : "")}
      onClick={onClick}
    >
      <span className="sb-item-icon">{icon}</span>
      <span className="flex-1 truncate">{label}</span>
      {badge && (
        <span
          className={"sb-item-badge" + (badgeKind === "live" ? " live" : "")}
        >
          {badge}
        </span>
      )}
    </button>
  );
}
