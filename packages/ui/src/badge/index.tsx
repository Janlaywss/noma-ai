export function Badge({
  kind = "idle",
}: {
  kind?: "live" | "idle" | "error" | "warn" | "think";
}) {
  return <span className={`status-dot status-dot-${kind}`} />;
}
