import { useMemo } from "react";
import { orderedColumns } from "../lib/format";
import type { RenderDirective } from "../lib/logsql";

interface Props {
  rows: Record<string, unknown>[];
  directive: RenderDirective;
  preferredColumns?: string[];
}

interface Point {
  x: number;
  xLabel: string;
  y: number;
}

interface Series {
  key: string;
  label: string;
  color: string;
  points: Point[];
}

interface ChartModel {
  xColumn: string;
  yColumns: string[];
  series: Series[];
  continuousX: boolean;
  timeX: boolean;
  categories: string[];
}

interface AreaLayer {
  series: Series;
  lower: Point[];
  upper: Point[];
}

const COLORS = [
  "#16897c", "#5b6fd8", "#d87b2f", "#b94f71", "#6b9f38",
  "#7b5cc7", "#d1a325", "#3182a4", "#ba5744", "#5d8b73",
];

const WIDTH = 960;
const HEIGHT = 430;
const MARGIN = { top: 24, right: 30, bottom: 64, left: 74 };
const PLOT_WIDTH = WIDTH - MARGIN.left - MARGIN.right;
const PLOT_HEIGHT = HEIGHT - MARGIN.top - MARGIN.bottom;

function asNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function asTime(value: unknown): number | null {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value !== "string" && typeof value !== "number") return null;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function valueLabel(value: unknown): string {
  if (value == null) return "—";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function listProperty(value = ""): string[] {
  return value.split(",").map((entry) => entry.trim().replace(/^(['"])(.*)\1$/, "$2")).filter(Boolean);
}

function numericColumns(rows: Record<string, unknown>[], columns: string[]): string[] {
  return columns.filter((column) => rows.some((row) => asNumber(row[column]) !== null));
}

function buildModel(rows: Record<string, unknown>[], directive: RenderDirective, preferredColumns: string[]): ChartModel | null {
  const columns = orderedColumns(rows, preferredColumns);
  if (columns.length === 0) return null;
  const type = directive.visualization;
  const explicitX = directive.properties.xcolumn;
  const timeCandidate = columns.find((column) => rows.some((row) => asTime(row[column]) !== null));
  const xColumn = explicitX && columns.includes(explicitX)
    ? explicitX
    : type === "timechart" || type === "anomalychart"
      ? timeCandidate ?? columns[0]
      : columns[0];
  let groupColumns = listProperty(directive.properties.series).filter((column) => columns.includes(column));
  const explicitY = listProperty(directive.properties.ycolumns).filter((column) => columns.includes(column));
  const candidates = columns.filter((column) => column !== xColumn && !groupColumns.includes(column));
  const yColumns = explicitY.length > 0 ? explicitY : numericColumns(rows, candidates);
  if (groupColumns.length === 0 && (type === "timechart" || type === "anomalychart")) {
    const group = columns.find((column) =>
      column !== xColumn
      && !yColumns.includes(column)
      && rows.some((row) => row[column] != null && asNumber(row[column]) === null));
    if (group) groupColumns = [group];
  }

  const numericX = rows.some((row) => asNumber(row[xColumn]) !== null);
  const timeX = type === "timechart"
    || type === "anomalychart"
    || (!numericX && rows.some((row) => asTime(row[xColumn]) !== null));
  const continuousX = timeX || numericX;
  const categories: string[] = [];
  const categoryIndexes = new Map<string, number>();
  const byKey = new Map<string, Series>();

  rows.forEach((row) => {
    const rawX = row[xColumn];
    const xLabel = valueLabel(rawX);
    let x: number;
    if (timeX) {
      const parsed = asTime(rawX);
      if (parsed === null) return;
      x = parsed;
    } else if (numericX) {
      const parsed = asNumber(rawX);
      if (parsed === null) return;
      x = parsed;
    } else {
      if (!categoryIndexes.has(xLabel)) {
        categoryIndexes.set(xLabel, categories.length);
        categories.push(xLabel);
      }
      x = categoryIndexes.get(xLabel) ?? 0;
    }

    const group = groupColumns.map((column) => valueLabel(row[column])).join(" · ");
    yColumns.forEach((column) => {
      const y = asNumber(row[column]);
      if (y === null) return;
      const key = `${group}\u0000${column}`;
      let series = byKey.get(key);
      if (!series) {
        const label = group ? (yColumns.length === 1 ? group : `${group} · ${column}`) : column;
        series = { key, label, color: COLORS[byKey.size % COLORS.length], points: [] };
        byKey.set(key, series);
      }
      series.points.push({ x, xLabel, y });
    });
  });

  const series = [...byKey.values()].map((entry) => ({
    ...entry,
    points: continuousX ? [...entry.points].sort((a, b) => a.x - b.x) : entry.points,
  }));
  return { xColumn, yColumns, series, continuousX, timeX, categories };
}

function formatNumber(value: number): string {
  if (value === 0) return "0";
  const absolute = Math.abs(value);
  if (absolute >= 1_000 || absolute < 0.01) {
    return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(value);
  }
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value);
}

function formatTime(value: number, span: number): string {
  const date = new Date(value);
  if (span <= 24 * 60 * 60 * 1_000) {
    return new Intl.DateTimeFormat(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(date);
  }
  if (span <= 7 * 24 * 60 * 60 * 1_000) {
    return new Intl.DateTimeFormat(undefined, {
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      hour12: false,
    }).format(date);
  }
  if (span <= 365 * 24 * 60 * 60 * 1_000) {
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
    }).format(date);
  }
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
  }).format(date);
}

function extent(values: number[]): [number, number] {
  let min = Math.min(...values);
  let max = Math.max(...values);
  if (min === max) {
    const padding = Math.abs(min) * 0.1 || 1;
    min -= padding;
    max += padding;
  }
  return [min, max];
}

function linePath(points: Point[], scaleX: (value: number) => number, scaleY: (value: number) => number): string {
  return points.map((point, index) => `${index === 0 ? "M" : "L"}${scaleX(point.x).toFixed(2)},${scaleY(point.y).toFixed(2)}`).join(" ");
}

function stackedAreaLayers(series: Series[]): AreaLayer[] {
  const positive = new Map<number, number>();
  const negative = new Map<number, number>();
  return series.map((entry) => {
    const lower: Point[] = [];
    const upper: Point[] = [];
    entry.points.forEach((point) => {
      const totals = point.y >= 0 ? positive : negative;
      const base = totals.get(point.x) ?? 0;
      const next = base + point.y;
      totals.set(point.x, next);
      lower.push({ ...point, y: base });
      upper.push({ ...point, y: next });
    });
    return { series: entry, lower, upper };
  });
}

function ChartHeading({ directive, model }: { directive: RenderDirective; model: ChartModel }) {
  const legendVisible = directive.properties.legend?.toLowerCase() !== "hidden";
  return (
    <>
      {directive.properties.title && <h3 className="chart-title">{directive.properties.title}</h3>}
      {legendVisible && model.series.length > 0 && (
        <div className="chart-legend" aria-label="Chart legend">
          {model.series.map((series) => (
            <span key={series.key}><i style={{ backgroundColor: series.color }} />{series.label}</span>
          ))}
        </div>
      )}
    </>
  );
}

function CartesianChart({ directive, model }: { directive: RenderDirective; model: ChartModel }) {
  const allPoints = model.series.flatMap((series) => series.points);
  if (allPoints.length === 0 || model.yColumns.length === 0) {
    return <ChartMessage>Chart data needs an x-axis column and at least one numeric y-axis column.</ChartMessage>;
  }

  const type = directive.visualization;
  const bars = type === "columnchart" || type === "barchart";
  const stacked = type === "stackedareachart" || (directive.properties.kind?.toLowerCase().startsWith("stacked") ?? false);
  const stackedArea = (type === "areachart" || type === "stackedareachart") && stacked;
  const areaLayers = stackedArea ? stackedAreaLayers(model.series) : [];
  const includeZero = bars || type === "areachart" || type === "stackedareachart";
  const [rawXMin, rawXMax] = extent(allPoints.map((point) => point.x));
  let yValues = allPoints.map((point) => point.y);
  if (stackedArea) yValues = areaLayers.flatMap((layer) => [...layer.lower, ...layer.upper].map((point) => point.y));
  if ((type === "columnchart" || type === "barchart") && stacked) {
    const positive = new Map<number, number>();
    const negative = new Map<number, number>();
    allPoints.forEach((point) => {
      const totals = point.y >= 0 ? positive : negative;
      totals.set(point.x, (totals.get(point.x) ?? 0) + point.y);
    });
    yValues = [...positive.values(), ...negative.values(), 0];
  }
  let [yMin, yMax] = extent(yValues);
  if (includeZero) {
    yMin = Math.min(0, yMin);
    yMax = Math.max(0, yMax);
  }
  const explicitYMin = asNumber(directive.properties.ymin);
  const explicitYMax = asNumber(directive.properties.ymax);
  if (explicitYMin !== null) yMin = explicitYMin;
  if (explicitYMax !== null) yMax = explicitYMax;
  if (yMin === yMax) yMax = yMin + 1;

  const xMin = rawXMin;
  const xMax = rawXMax;
  const categoryCount = new Set(allPoints.map((point) => point.x)).size;
  const scaleX = (value: number) => model.continuousX
    ? MARGIN.left + (value - xMin) / (xMax - xMin) * PLOT_WIDTH
    : MARGIN.left + (value + 0.5) / Math.max(1, categoryCount) * PLOT_WIDTH;
  const scaleY = (value: number) => MARGIN.top + (yMax - value) / (yMax - yMin) * PLOT_HEIGHT;
  const yTicks = Array.from({ length: 5 }, (_, index) => yMin + (yMax - yMin) * index / 4);
  const xTickValues = model.continuousX
    ? Array.from({ length: 5 }, (_, index) => xMin + (xMax - xMin) * index / 4)
    : [...new Set(allPoints.map((point) => point.x))].filter((_, index, values) =>
      values.length <= 7 || index % Math.ceil(values.length / 7) === 0);
  const xLabels = new Map(allPoints.map((point) => [point.x, point.xLabel]));
  const formatXTick = (value: number) => model.timeX
    ? formatTime(value, xMax - xMin)
    : model.continuousX
      ? formatNumber(value)
      : xLabels.get(value) ?? String(value);

  if (type === "barchart") {
    return <HorizontalBars directive={directive} model={model} yMin={yMin} yMax={yMax} />;
  }

  const uniqueX = [...new Set(allPoints.map((point) => point.x))].sort((a, b) => a - b);
  const columnStep = PLOT_WIDTH / Math.max(1, uniqueX.length);
  const columnWidth = Math.min(54, columnStep * 0.78);

  return (
    <div className="chart-view">
      <ChartHeading directive={directive} model={model} />
      <svg className="chart-svg" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label={`${type} visualization`}>
        {yTicks.map((tick) => (
          <g key={tick}>
            <line className="chart-grid" x1={MARGIN.left} x2={WIDTH - MARGIN.right} y1={scaleY(tick)} y2={scaleY(tick)} />
            <text className="chart-tick chart-y-tick" x={MARGIN.left - 12} y={scaleY(tick) + 4}>{formatNumber(tick)}</text>
          </g>
        ))}
        {xTickValues.map((tick, index) => (
          <g key={tick}>
            <line className="chart-axis-mark" x1={scaleX(tick)} x2={scaleX(tick)} y1={HEIGHT - MARGIN.bottom} y2={HEIGHT - MARGIN.bottom + 5} />
            <text
              className="chart-tick chart-x-tick"
              x={scaleX(tick)}
              y={HEIGHT - MARGIN.bottom + 20}
              textAnchor={model.continuousX
                ? index === 0
                  ? "start"
                  : index === xTickValues.length - 1
                    ? "end"
                    : "middle"
                : "middle"}
              aria-label={model.timeX ? new Date(tick).toLocaleString() : undefined}
            >
              {formatXTick(tick)}
            </text>
          </g>
        ))}
        <line className="chart-axis" x1={MARGIN.left} x2={MARGIN.left} y1={MARGIN.top} y2={HEIGHT - MARGIN.bottom} />
        <line className="chart-axis" x1={MARGIN.left} x2={WIDTH - MARGIN.right} y1={HEIGHT - MARGIN.bottom} y2={HEIGHT - MARGIN.bottom} />

        {type === "columnchart" && uniqueX.flatMap((x, xIndex) => {
          let positiveStack = 0;
          let negativeStack = 0;
          return model.series.map((series, seriesIndex) => {
            const point = series.points.find((candidate) => candidate.x === x);
            if (!point) return null;
            const base = point.y >= 0 ? positiveStack : negativeStack;
            const next = base + point.y;
            if (stacked) {
              if (point.y >= 0) positiveStack = next;
              else negativeStack = next;
            }
            const barX = MARGIN.left + columnStep * xIndex + (columnStep - columnWidth) / 2
              + (stacked ? 0 : columnWidth / model.series.length * seriesIndex);
            const width = stacked ? columnWidth : columnWidth / model.series.length;
            const top = scaleY(stacked ? Math.max(base, next) : Math.max(0, point.y));
            const bottom = scaleY(stacked ? Math.min(base, next) : Math.min(0, point.y));
            return (
              <rect
                className="chart-bar"
                key={`${series.key}-${x}`}
                x={barX}
                y={top}
                width={Math.max(1, width - 2)}
                height={Math.max(1, bottom - top)}
                fill={series.color}
              >
                <title>{`${point.xLabel} · ${series.label}: ${formatNumber(point.y)}`}</title>
              </rect>
            );
          });
        })}

        {(type === "areachart" || type === "stackedareachart") && !stackedArea && model.series.map((series) => {
          const path = linePath(series.points, scaleX, scaleY);
          const first = series.points[0];
          const last = series.points.at(-1);
          if (!first || !last) return null;
          const baseline = scaleY(Math.max(yMin, Math.min(yMax, 0)));
          return <path key={`${series.key}-area`} d={`${path} L${scaleX(last.x)},${baseline} L${scaleX(first.x)},${baseline} Z`} fill={series.color} opacity={0.2} />;
        })}

        {stackedArea && areaLayers.map((layer) => {
          const upper = linePath(layer.upper, scaleX, scaleY);
          const lower = [...layer.lower].reverse().map((point) => `L${scaleX(point.x).toFixed(2)},${scaleY(point.y).toFixed(2)}`).join(" ");
          return (
            <g key={`${layer.series.key}-stack`}>
              <path d={`${upper} ${lower} Z`} fill={layer.series.color} opacity={0.58} />
              <path className="chart-line" d={upper} stroke={layer.series.color} />
            </g>
          );
        })}

        {type !== "columnchart" && !stackedArea && model.series.map((series) => (
          <g key={series.key}>
            {type !== "scatterchart" && (
              <path className="chart-line" d={linePath(series.points, scaleX, scaleY)} stroke={series.color} />
            )}
            {series.points.map((point, index) => (
              <circle
                className="chart-point"
                key={`${point.x}-${index}`}
                cx={scaleX(point.x)}
                cy={scaleY(point.y)}
                r={type === "scatterchart" || type === "anomalychart" ? 4 : 2.5}
                fill={series.color}
              >
                <title>{`${point.xLabel} · ${series.label}: ${formatNumber(point.y)}`}</title>
              </circle>
            ))}
          </g>
        ))}

        <text className="chart-axis-title chart-x-title" x={MARGIN.left + PLOT_WIDTH / 2} y={HEIGHT - 13}>
          {directive.properties.xtitle || model.xColumn}
        </text>
        <text className="chart-axis-title chart-y-title" transform={`translate(18 ${MARGIN.top + PLOT_HEIGHT / 2}) rotate(-90)`}>
          {directive.properties.ytitle || (model.yColumns.length === 1 ? model.yColumns[0] : "Value")}
        </text>
      </svg>
    </div>
  );
}

function HorizontalBars({
  directive,
  model,
  yMin,
  yMax,
}: {
  directive: RenderDirective;
  model: ChartModel;
  yMin: number;
  yMax: number;
}) {
  const categories = [...new Set(model.series.flatMap((series) => series.points.map((point) => point.xLabel)))];
  if (categories.length === 0) return <ChartMessage>Bar chart data has no categories to display.</ChartMessage>;
  const height = Math.max(320, categories.length * Math.max(28, model.series.length * 15) + 110);
  const top = 24;
  const bottom = 45;
  const left = 150;
  const right = 35;
  const plotWidth = WIDTH - left - right;
  const plotHeight = height - top - bottom;
  const scale = (value: number) => left + (value - yMin) / (yMax - yMin) * plotWidth;
  const categoryHeight = plotHeight / categories.length;
  const stacked = directive.properties.kind?.toLowerCase().startsWith("stacked") ?? false;
  const barHeight = stacked
    ? Math.min(22, categoryHeight * 0.7)
    : Math.min(22, categoryHeight * 0.75 / Math.max(1, model.series.length));

  return (
    <div className="chart-view">
      <ChartHeading directive={directive} model={model} />
      <svg className="chart-svg chart-svg-bars" viewBox={`0 0 ${WIDTH} ${height}`} role="img" aria-label="barchart visualization">
        {Array.from({ length: 5 }, (_, index) => yMin + (yMax - yMin) * index / 4).map((tick) => (
          <g key={tick}>
            <line className="chart-grid" x1={scale(tick)} x2={scale(tick)} y1={top} y2={height - bottom} />
            <text className="chart-tick chart-x-tick" x={scale(tick)} y={height - bottom + 20} textAnchor="middle">{formatNumber(tick)}</text>
          </g>
        ))}
        {categories.map((category, categoryIndex) => {
          let positiveStack = 0;
          let negativeStack = 0;
          return (
            <g key={category}>
              <text className="chart-tick chart-category-tick" x={left - 12} y={top + categoryHeight * (categoryIndex + 0.5) + 4}>{category}</text>
              {model.series.map((series, seriesIndex) => {
                const point = series.points.find((candidate) => candidate.xLabel === category);
                if (!point) return null;
                const base = stacked ? (point.y >= 0 ? positiveStack : negativeStack) : 0;
                const next = base + point.y;
                if (stacked) {
                  if (point.y >= 0) positiveStack = next;
                  else negativeStack = next;
                }
                const start = scale(Math.min(base, next));
                const end = scale(Math.max(base, next));
                return (
                  <rect
                    className="chart-bar"
                    key={series.key}
                    x={start}
                    y={stacked
                      ? top + categoryHeight * categoryIndex + (categoryHeight - barHeight) / 2
                      : top + categoryHeight * categoryIndex + (categoryHeight - barHeight * model.series.length) / 2 + barHeight * seriesIndex}
                    width={Math.max(1, end - start)}
                    height={Math.max(2, barHeight - 2)}
                    fill={series.color}
                  >
                    <title>{`${category} · ${series.label}: ${formatNumber(point.y)}`}</title>
                  </rect>
                );
              })}
            </g>
          );
        })}
        <line className="chart-axis" x1={scale(0)} x2={scale(0)} y1={top} y2={height - bottom} />
      </svg>
    </div>
  );
}

function PieChart({ directive, model }: { directive: RenderDirective; model: ChartModel }) {
  const series = model.series[0];
  if (!series) return <ChartMessage>Pie chart data needs a category column followed by a numeric column.</ChartMessage>;
  const values = new Map<string, number>();
  series.points.forEach((point) => values.set(point.xLabel, (values.get(point.xLabel) ?? 0) + Math.max(0, point.y)));
  const slices = [...values].filter(([, value]) => value > 0);
  const total = slices.reduce((sum, [, value]) => sum + value, 0);
  if (total <= 0) return <ChartMessage>Pie chart values must include at least one positive number.</ChartMessage>;
  const centerX = 330;
  const centerY = 215;
  const radius = 155;
  let angle = -Math.PI / 2;
  const arc = (start: number, end: number) => {
    const startX = centerX + Math.cos(start) * radius;
    const startY = centerY + Math.sin(start) * radius;
    const endX = centerX + Math.cos(end) * radius;
    const endY = centerY + Math.sin(end) * radius;
    return `M${centerX},${centerY} L${startX},${startY} A${radius},${radius} 0 ${end - start > Math.PI ? 1 : 0} 1 ${endX},${endY} Z`;
  };

  return (
    <div className="chart-view">
      {directive.properties.title && <h3 className="chart-title">{directive.properties.title}</h3>}
      <svg className="chart-svg" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label="piechart visualization">
        {slices.map(([label, value], index) => {
          const start = angle;
          const end = angle + value / total * Math.PI * 2;
          angle = end;
          const color = COLORS[index % COLORS.length];
          return (
            <path className="chart-slice" key={label} d={arc(start, end)} fill={color}>
              <title>{`${label}: ${formatNumber(value)} (${(value / total * 100).toFixed(1)}%)`}</title>
            </path>
          );
        })}
        {slices.map(([label, value], index) => (
          <g key={`${label}-legend`} transform={`translate(565 ${70 + index * 29})`}>
            <rect width="11" height="11" rx="2" fill={COLORS[index % COLORS.length]} />
            <text className="chart-pie-label" x="19" y="10">{label}</text>
            <text className="chart-pie-value" x="330" y="10">{`${formatNumber(value)} · ${(value / total * 100).toFixed(1)}%`}</text>
          </g>
        ))}
      </svg>
    </div>
  );
}

function CardChart({ rows, directive }: { rows: Record<string, unknown>[]; directive: RenderDirective }) {
  const row = rows[0];
  if (!row) return <ChartMessage>Card visualization needs at least one result row.</ChartMessage>;
  const selected = listProperty(directive.properties.ycolumns);
  const entries = Object.entries(row).filter(([column]) => selected.length === 0 || selected.includes(column));
  return (
    <div className="chart-view chart-card-view">
      {directive.properties.title && <h3 className="chart-title">{directive.properties.title}</h3>}
      <div className="chart-cards">
        {entries.map(([column, value]) => (
          <article key={column}>
            <span>{column}</span>
            <strong>{typeof value === "number" ? formatNumber(value) : valueLabel(value)}</strong>
          </article>
        ))}
      </div>
    </div>
  );
}

function ChartMessage({ children }: { children: string }) {
  return (
    <div className="chart-message">
      <strong>Unable to render visualization</strong>
      <p>{children}</p>
    </div>
  );
}

export function ChartViewer({ rows, directive, preferredColumns = [] }: Props) {
  const model = useMemo(
    () => buildModel(rows, directive, preferredColumns),
    [directive, preferredColumns, rows],
  );
  if (!directive.supported) {
    return (
      <ChartMessage>
        {`“${directive.visualization}” is not supported. Use timechart, linechart, areachart, stackedareachart, columnchart, barchart, piechart, scatterchart, anomalychart, or card.`}
      </ChartMessage>
    );
  }
  if (directive.visualization === "card") return <CardChart rows={rows} directive={directive} />;
  if (!model) return <ChartMessage>The result has no columns to visualize.</ChartMessage>;
  if (directive.visualization === "piechart") return <PieChart directive={directive} model={model} />;
  return <CartesianChart directive={directive} model={model} />;
}
