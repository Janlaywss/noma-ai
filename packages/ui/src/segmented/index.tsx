export function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: Array<{ id: T; label: string; icon?: string }>;
  onChange: (v: T) => void;
}) {
  return (
    <div
      style={{
        display: "inline-flex",
        border: "1px solid var(--line)",
        borderRadius: 6,
        overflow: "hidden",
        background: "white",
      }}
    >
      {options.map((o) => (
        <div
          key={o.id}
          onClick={() => onChange(o.id)}
          style={{
            padding: "6px 14px",
            fontSize: 12,
            fontWeight: value === o.id ? 600 : 400,
            background: value === o.id ? "var(--ink)" : "white",
            color: value === o.id ? "white" : "var(--ink)",
            cursor: "pointer",
            borderRight: "1px solid var(--line)",
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          {o.icon && <span>{o.icon}</span>}
          {o.label}
        </div>
      ))}
    </div>
  );
}
