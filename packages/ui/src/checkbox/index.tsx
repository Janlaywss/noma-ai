export function Checkbox({
  on,
  onChange,
}: {
  on: boolean;
  onChange?: (v: boolean) => void;
}) {
  return (
    <div
      style={{
        width: 13,
        height: 13,
        borderRadius: 3,
        border: `1.5px solid ${on ? "var(--ink)" : "var(--line)"}`,
        background: on ? "var(--ink)" : "white",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: "white",
        fontSize: 9,
        fontWeight: 700,
        cursor: "pointer",
      }}
      onClick={() => onChange?.(!on)}
    >
      {on && "✓"}
    </div>
  );
}
