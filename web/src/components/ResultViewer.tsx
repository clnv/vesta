import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronDown, ChevronRight, Copy } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { orderedColumns } from "../lib/format";
import type { ResultMode } from "../types";

interface Props {
  rows: Record<string, unknown>[];
  mode: ResultMode;
  onCopy(value: string): void;
}

function display(value: unknown): string {
  if (value == null) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}

export function ResultViewer({ rows, mode, onCopy }: Props) {
  const parentRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState<number | null>(null);
  const columns = useMemo(() => orderedColumns(rows), [rows]);
  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => mode === "log" ? 46 : 34,
    overscan: 12,
    measureElement: (element) => element.getBoundingClientRect().height,
  });

  if (rows.length === 0) {
    return (
      <div className="result-empty">
        <div className="empty-orbit"><span /></div>
        <strong>Ready for a query</strong>
        <p>Results stream here as VictoriaLogs finds them.</p>
      </div>
    );
  }

  return (
    <div className={`result-scroll result-${mode}`} ref={parentRef}>
      {mode === "table" && (
        <div className="table-header" style={{ gridTemplateColumns: `repeat(${columns.length}, minmax(150px, 1fr))` }}>
          {columns.map((column) => <div key={column}>{column}</div>)}
        </div>
      )}
      <div className="virtual-canvas" style={{ height: `${rowVirtualizer.getTotalSize()}px` }}>
        {rowVirtualizer.getVirtualItems().map((virtualRow) => {
          const row = rows[virtualRow.index];
          if (mode === "table") {
            return (
              <div
                className="table-row"
                key={virtualRow.key}
                data-index={virtualRow.index}
                ref={rowVirtualizer.measureElement}
                style={{ transform: `translateY(${virtualRow.start}px)`, gridTemplateColumns: `repeat(${columns.length}, minmax(150px, 1fr))` }}
              >
                {columns.map((column) => (
                  <button className="table-cell" key={column} title={`Copy ${column}`} onClick={() => onCopy(display(row[column]))}>
                    {display(row[column]) || <span className="null-value">—</span>}
                  </button>
                ))}
              </div>
            );
          }
          if (mode === "json") {
            return (
              <div className="json-row" key={virtualRow.key} data-index={virtualRow.index} ref={rowVirtualizer.measureElement} style={{ transform: `translateY(${virtualRow.start}px)` }}>
                <span>{String(virtualRow.index + 1).padStart(3, "0")}</span>
                <code>{JSON.stringify(row)}</code>
                <button className="icon-button subtle" aria-label="Copy JSON row" onClick={() => onCopy(JSON.stringify(row))}><Copy size={14} /></button>
              </div>
            );
          }
          const open = expanded === virtualRow.index;
          return (
            <div className={`log-row ${open ? "expanded" : ""}`} key={virtualRow.key} data-index={virtualRow.index} ref={rowVirtualizer.measureElement} style={{ transform: `translateY(${virtualRow.start}px)` }}>
              <button className="log-summary" onClick={() => setExpanded(open ? null : virtualRow.index)}>
                {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                <time>{display(row._time) || "no timestamp"}</time>
                <span>{display(row._msg) || JSON.stringify(row)}</span>
              </button>
              {open && <pre>{JSON.stringify(row, null, 2)}</pre>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

