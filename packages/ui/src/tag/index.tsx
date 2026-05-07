import type { ReactNode, CSSProperties } from "react";

export function Tag({
  children,
  kind,
  style,
}: {
  children: ReactNode;
  kind?: "accent" | "ok" | "warn" | "danger";
  style?: CSSProperties;
}) {
  const cls = "pill" + (kind ? ` pill-${kind}` : "");
  return (
    <span className={cls} style={style}>
      {children}
    </span>
  );
}
