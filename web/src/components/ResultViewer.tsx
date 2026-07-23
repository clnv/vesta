import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronDown, ChevronRight, Copy } from "lucide-react";
import { useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { orderedColumns } from "../lib/format";
import { columnsFromQuery } from "../lib/logsql";
import type { ResultMode } from "../types";

interface Props {
  rows: Record<string, unknown>[];
  mode: ResultMode;
  query?: string;
  onCopy(value: string): void;
}

type ExpandedDetail =
  | { row: number; kind: "json" }
  | { row: number; kind: "field"; column: string };

const TABLE_COLUMN_MIN_WIDTH = 150;
const TABLE_COLUMN_RESIZE_MIN_WIDTH = 80;
const TABLE_COLUMN_RESIZE_MAX_WIDTH = 2000;
const TABLE_EXPAND_COLUMN_WIDTH = 34;
const TABLE_COLUMN_KEYBOARD_STEP = 16;

function display(value: unknown): string {
  if (value == null) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}

function detailDisplay(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2) ?? String(value);
}

function levelClass(row: Record<string, unknown>): string {
  const level = Object.entries(row).find(([field]) => field.toLowerCase() === "level")?.[1];
  if (typeof level !== "string") return "";
  switch (level.trim().toLowerCase()) {
    case "error":
      return "level-error";
    case "warn":
    case "warning":
      return "level-warn";
    default:
      return "";
  }
}

export function ResultViewer({ rows, mode, query = "", onCopy }: Props) {
  const parentRef = useRef<HTMLDivElement>(null);
  const resizeRef = useRef<{ column: string; pointerId: number; startX: number; startWidth: number } | null>(null);
  const [expanded, setExpanded] = useState<ExpandedDetail | null>(null);
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>({});
  const columns = useMemo(() => orderedColumns(rows, columnsFromQuery(query)), [query, rows]);
  const tableGridTemplate = `${TABLE_EXPAND_COLUMN_WIDTH}px ${columns.map((column) => columnWidths[column] ? `${columnWidths[column]}px` : `minmax(${TABLE_COLUMN_MIN_WIDTH}px, 1fr)`).join(" ")}`;
  const tableWidth = `max(100%, ${TABLE_EXPAND_COLUMN_WIDTH + columns.reduce((width, column) => width + (columnWidths[column] ?? TABLE_COLUMN_MIN_WIDTH), 0)}px)`;
  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 34,
    overscan: 12,
    measureElement: (element) => element.getBoundingClientRect().height,
  });

  const setColumnWidth = (column: string, width: number) => {
    setColumnWidths((current) => ({
      ...current,
      [column]: Math.min(TABLE_COLUMN_RESIZE_MAX_WIDTH, Math.max(TABLE_COLUMN_RESIZE_MIN_WIDTH, Math.round(width))),
    }));
  };

  const beginColumnResize = (event: ReactPointerEvent<HTMLDivElement>, column: string) => {
    event.preventDefault();
    const measuredWidth = event.currentTarget.parentElement?.getBoundingClientRect().width ?? 0;
    resizeRef.current = {
      column,
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: measuredWidth || columnWidths[column] || TABLE_COLUMN_MIN_WIDTH,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const continueColumnResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const resize = resizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    setColumnWidth(resize.column, resize.startWidth + event.clientX - resize.startX);
  };

  const endColumnResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (resizeRef.current?.pointerId !== event.pointerId) return;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    resizeRef.current = null;
  };

  const resizeColumnWithKeyboard = (event: ReactKeyboardEvent<HTMLDivElement>, column: string) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const measuredWidth = event.currentTarget.parentElement?.getBoundingClientRect().width ?? 0;
    const currentWidth = columnWidths[column] || measuredWidth || TABLE_COLUMN_MIN_WIDTH;
    setColumnWidth(column, currentWidth + (event.key === "ArrowRight" ? TABLE_COLUMN_KEYBOARD_STEP : -TABLE_COLUMN_KEYBOARD_STEP));
  };

  const resetColumnWidth = (column: string) => {
    setColumnWidths((current) => {
      const next = { ...current };
      delete next[column];
      return next;
    });
  };

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
        <div className="table-header" style={{ gridTemplateColumns: tableGridTemplate, width: tableWidth }}>
          <div className="table-expand-header" aria-hidden="true" />
          {columns.map((column) => (
            <div className="table-header-cell" key={column}>
              <span>{column}</span>
              <div
                className="table-column-resizer"
                role="separator"
                aria-label={`Resize ${column} column`}
                aria-orientation="vertical"
                aria-valuemin={TABLE_COLUMN_RESIZE_MIN_WIDTH}
                aria-valuemax={TABLE_COLUMN_RESIZE_MAX_WIDTH}
                aria-valuenow={columnWidths[column] ?? TABLE_COLUMN_MIN_WIDTH}
                tabIndex={0}
                title="Drag to resize; double-click to reset"
                onPointerDown={(event) => beginColumnResize(event, column)}
                onPointerMove={continueColumnResize}
                onPointerUp={endColumnResize}
                onPointerCancel={endColumnResize}
                onKeyDown={(event) => resizeColumnWithKeyboard(event, column)}
                onDoubleClick={() => resetColumnWidth(column)}
              />
            </div>
          ))}
        </div>
      )}
      <div
        className="virtual-canvas"
        style={{ height: `${rowVirtualizer.getTotalSize()}px`, width: mode === "table" ? tableWidth : undefined }}
      >
        {rowVirtualizer.getVirtualItems().map((virtualRow) => {
          const row = rows[virtualRow.index];
          if (mode === "table") {
            const detail = expanded?.row === virtualRow.index ? expanded : null;
            const jsonOpen = detail?.kind === "json";
            const severity = levelClass(row);
            return (
              <div
                className={`table-row ${severity} ${detail ? "expanded" : ""}`}
                key={virtualRow.key}
                data-index={virtualRow.index}
                ref={rowVirtualizer.measureElement}
                style={{ transform: `translateY(${virtualRow.start}px)`, gridTemplateColumns: tableGridTemplate }}
              >
                <button
                  className="table-expander"
                  aria-expanded={jsonOpen}
                  aria-label={`${jsonOpen ? "Collapse" : "Expand"} row ${virtualRow.index + 1} JSON`}
                  onClick={() => setExpanded(jsonOpen ? null : { row: virtualRow.index, kind: "json" })}
                >
                  {jsonOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                </button>
                {columns.map((column) => {
                  const fieldOpen = detail?.kind === "field" && detail.column === column;
                  return (
                    <button
                      className={`table-cell ${fieldOpen ? "active" : ""}`}
                      key={column}
                      title={`Inspect full ${column} value`}
                      aria-expanded={fieldOpen}
                      aria-label={`Inspect ${column} in row ${virtualRow.index + 1}`}
                      onClick={() => setExpanded(fieldOpen ? null : { row: virtualRow.index, kind: "field", column })}
                    >
                      {display(row[column]) || <span className="null-value">—</span>}
                    </button>
                  );
                })}
                {jsonOpen && (
                  <div className="table-row-json">
                    <button
                      className="table-json-copy"
                      aria-label={`Copy row ${virtualRow.index + 1} full JSON`}
                      onClick={() => onCopy(JSON.stringify(row, null, 2))}
                    >
                      <Copy size={13} /> Copy JSON
                    </button>
                    <pre>{JSON.stringify(row, null, 2)}</pre>
                  </div>
                )}
                {detail?.kind === "field" && (
                  <div className="table-field-detail">
                    <div className="table-field-detail-header">
                      <strong>{detail.column}</strong>
                      <button
                        className="table-field-copy"
                        aria-label={`Copy ${detail.column} from row ${virtualRow.index + 1}`}
                        onClick={() => onCopy(detailDisplay(row[detail.column]))}
                      >
                        <Copy size={13} /> Copy value
                      </button>
                    </div>
                    <pre>{detailDisplay(row[detail.column])}</pre>
                  </div>
                )}
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
          return null;
        })}
      </div>
    </div>
  );
}
