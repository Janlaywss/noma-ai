import type { ReactNode, CSSProperties, InputHTMLAttributes } from "react";

export interface InputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "size" | "prefix"> {
  /** Prefix icon/element rendered before the input */
  prefix?: ReactNode;
  /** Suffix element rendered after the input */
  suffix?: ReactNode;
  /** Control height: default 28, "lg" = 36 */
  size?: "default" | "lg";
  /** Wrapper style override */
  style?: CSSProperties;
}

export function Input({
  prefix,
  suffix,
  size = "default",
  style,
  className,
  readOnly,
  placeholder,
  ...rest
}: InputProps) {
  const height = size === "lg" ? 36 : 28;

  // If we have prefix/suffix, render a wrapper div with the input inside
  if (prefix || suffix) {
    return (
      <div
        className={"input row gap-2" + (className ? ` ${className}` : "")}
        style={{
          height,
          alignItems: "center",
          display: "flex",
          ...style,
        }}
      >
        {prefix && (
          <span style={{ flexShrink: 0, display: "inline-flex" }}>
            {prefix}
          </span>
        )}
        <input
          {...rest}
          readOnly={readOnly}
          placeholder={placeholder}
          style={{
            flex: 1,
            border: "none",
            outline: "none",
            background: "transparent",
            font: "inherit",
            fontSize: size === "lg" ? 13 : 12,
            color: "inherit",
            width: "100%",
            padding: 0,
          }}
        />
        {suffix && (
          <span style={{ flexShrink: 0, display: "inline-flex" }}>
            {suffix}
          </span>
        )}
      </div>
    );
  }

  // Simple input without prefix/suffix
  return (
    <input
      {...rest}
      className={"input" + (className ? ` ${className}` : "")}
      readOnly={readOnly}
      placeholder={placeholder}
      style={{
        height,
        fontSize: size === "lg" ? 13 : 12,
        width: "100%",
        ...style,
      }}
    />
  );
}
