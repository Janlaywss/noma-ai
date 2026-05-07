import type { ReactNode, CSSProperties } from "react";

export function Button({
  children,
  kind = "default",
  icon,
  size,
  style,
  onClick,
  disabled,
}: {
  children?: ReactNode;
  kind?: "default" | "primary" | "ghost";
  icon?: string;
  size?: "sm";
  style?: CSSProperties;
  onClick?: () => void;
  disabled?: boolean;
}) {
  const cls =
    "btn" +
    (kind === "primary" ? " btn-primary" : kind === "ghost" ? " btn-ghost" : "") +
    (size === "sm" ? " btn-sm" : "");
  return (
    <button className={cls} style={style} onClick={onClick} disabled={disabled}>
      {icon && <span style={{ opacity: 0.8 }}>{icon}</span>}
      {children}
    </button>
  );
}
