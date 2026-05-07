export function Avatar({
  initials = "U",
  color,
  size = 24,
}: {
  initials?: string;
  color?: string;
  size?: number;
}) {
  return (
    <div
      className="avatar"
      style={{ background: color, width: size, height: size }}
    >
      {initials}
    </div>
  );
}
