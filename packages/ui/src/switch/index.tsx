export function Switch({
  on,
  onChange,
}: {
  on: boolean;
  onChange?: (v: boolean) => void;
}) {
  return (
    <div
      style={{
        width: 36,
        height: 20,
        borderRadius: 999,
        background: on ? "var(--ink)" : "var(--line)",
        position: "relative",
        cursor: "pointer",
        transition: "background 0.15s",
      }}
      onClick={() => onChange?.(!on)}
    >
      <div
        style={{
          position: "absolute",
          top: 2,
          left: on ? 18 : 2,
          width: 16,
          height: 16,
          borderRadius: 999,
          background: "white",
          transition: "left 0.15s",
          boxShadow: "0 1px 2px rgba(0,0,0,0.2)",
        }}
      />
    </div>
  );
}
