import type { ReactNode, CSSProperties } from "react";
import { useState, useRef, useEffect } from "react";

export interface SelectOption<T extends string = string> {
  id: T;
  label: ReactNode;
  sublabel?: ReactNode;
  icon?: ReactNode;
}

export function Select<T extends string = string>({
  value,
  options,
  onChange,
  width = 280,
  maxHeight = 280,
  placeholder,
  style,
}: {
  value: T;
  options: SelectOption<T>[];
  onChange: (v: T) => void;
  width?: number;
  maxHeight?: number;
  placeholder?: string;
  style?: CSSProperties;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const current = options.find((o) => o.id === value);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  return (
    <div ref={ref} style={{ position: "relative", width, ...style }}>
      {/* trigger */}
      <div
        className="input row gap-2"
        style={{
          width,
          height: 36,
          alignItems: "center",
          cursor: "pointer",
          display: "flex",
        }}
        onClick={() => setOpen(!open)}
      >
        {current?.icon && <span style={{ fontSize: 14, flexShrink: 0 }}>{current.icon}</span>}
        <span className="flex-1 truncate" style={{ fontSize: 13 }}>
          {current ? (
            <>
              {current.label}
              {current.sublabel && (
                <span className="muted" style={{ marginLeft: 8, fontSize: 11 }}>
                  {current.sublabel}
                </span>
              )}
            </>
          ) : (
            <span className="muted">{placeholder}</span>
          )}
        </span>
        <span className="muted" style={{ flexShrink: 0 }}>{open ? "⌃" : "⌄"}</span>
      </div>

      {/* dropdown */}
      {open && (
        <div
          className="card"
          style={{
            position: "absolute",
            top: "100%",
            left: 0,
            marginTop: 4,
            padding: 4,
            width,
            maxHeight,
            overflow: "auto",
            zIndex: 50,
          }}
        >
          {options.map((o) => (
            <div
              key={o.id}
              onClick={() => {
                onChange(o.id);
                setOpen(false);
              }}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "8px 10px",
                borderRadius: 4,
                background: value === o.id ? "var(--accent-soft)" : "transparent",
                cursor: "pointer",
                fontSize: 13,
              }}
            >
              {o.icon && <span style={{ fontSize: 14, flexShrink: 0 }}>{o.icon}</span>}
              <span className="flex-1 truncate">
                {o.label}
                {o.sublabel && (
                  <span className="muted" style={{ marginLeft: 8, fontSize: 11 }}>
                    {o.sublabel}
                  </span>
                )}
              </span>
              {value === o.id && (
                <span style={{ color: "var(--accent)", fontWeight: 600, flexShrink: 0 }}>✓</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
