export function Logo({ size = 22 }: { size?: number }) {
  return (
    <div
      className="sb-logo"
      style={{ width: size, height: size, fontSize: size * 0.5 }}
    >
      ◆
    </div>
  );
}
