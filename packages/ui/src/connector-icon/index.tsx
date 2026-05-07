const CONNECTOR_COLORS: Record<
  string,
  { bg: string; fg: string; glyph: string }
> = {
  gmail: { bg: "#fef2f2", fg: "#dc2626", glyph: "M" },
  github: { bg: "#1f2937", fg: "#fff", glyph: "G" },
  stocks: { bg: "#ecfdf5", fg: "#059669", glyph: "$" },
  slack: { bg: "#f5f3ff", fg: "#7c3aed", glyph: "#" },
  lark: { bg: "#eff6ff", fg: "#2563eb", glyph: "L" },
  jin10: { bg: "#fffbeb", fg: "#b45309", glyph: "金" },
  cal: { bg: "#fdf4ff", fg: "#a21caf", glyph: "◷" },
  rss: { bg: "#fff7ed", fg: "#ea580c", glyph: "⌘" },
  notion: { bg: "#f9fafb", fg: "#111", glyph: "N" },
  linear: { bg: "#eef2ff", fg: "#4f46e5", glyph: "⌃" },
  x: { bg: "#f9fafb", fg: "#111", glyph: "𝕏" },
};
const GENERIC = { bg: "#f3f4f6", fg: "#525252", glyph: "◇" };

export function ConnectorIcon({
  name = "generic",
  size = 32,
}: {
  name?: string;
  size?: number;
}) {
  const c = CONNECTOR_COLORS[name] ?? GENERIC;
  return (
    <div
      className="conn-icon"
      style={{
        width: size,
        height: size,
        background: c.bg,
        color: c.fg,
        fontSize: size * 0.45,
      }}
    >
      {c.glyph}
    </div>
  );
}
