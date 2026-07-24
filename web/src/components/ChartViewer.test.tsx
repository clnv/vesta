import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RenderDirective } from "../lib/logsql";
import { ChartViewer } from "./ChartViewer";

function directive(visualization: string, properties: Record<string, string> = {}): RenderDirective {
  return {
    visualization,
    supported: visualization !== "treemap",
    properties,
    executableQuery: "_time:1h | stats count()",
  };
}

describe("ChartViewer", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("redraws the chart to match its available pane area", () => {
    let resizeCallback: ResizeObserverCallback | undefined;
    class ResizeObserverMock {
      constructor(callback: ResizeObserverCallback) {
        resizeCallback = callback;
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);

    const { container } = render(
      <ChartViewer
        directive={directive("linechart", { xcolumn: "minute", ycolumns: "requests" })}
        rows={[
          { minute: 1, requests: 10 },
          { minute: 2, requests: 14 },
        ]}
      />,
    );
    const chartCanvas = container.querySelector(".chart-canvas");
    const chart = screen.getByRole("img", { name: "linechart visualization" });
    expect(chartCanvas).not.toBeNull();

    act(() => {
      resizeCallback?.(
        [{ contentRect: { width: 720, height: 300 } } as ResizeObserverEntry],
        {} as ResizeObserver,
      );
    });

    expect(chart).toHaveAttribute("width", "720");
    expect(chart).toHaveAttribute("height", "300");
    expect(chart).toHaveAttribute("viewBox", "0 0 720 300");
  });

  it("renders compact time ticks for a grouped timechart", () => {
    const { container } = render(
      <ChartViewer
        directive={directive("timechart", { title: "Requests", xcolumn: "_time", ycolumns: "requests" })}
        rows={[
          { _time: "2026-07-23T00:00:00Z", service: "api", requests: "10" },
          { _time: "2026-07-23T00:05:00Z", service: "api", requests: "14" },
          { _time: "2026-07-23T00:00:00Z", service: "web", requests: "7" },
          { _time: "2026-07-23T00:05:00Z", service: "web", requests: "9" },
        ]}
      />,
    );

    expect(screen.getByRole("img", { name: "timechart visualization" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Requests" })).toBeInTheDocument();
    expect(screen.getByLabelText("Chart legend")).toHaveTextContent("api");
    expect(screen.getByLabelText("Chart legend")).toHaveTextContent("web");
    expect(container.querySelectorAll(".chart-line")).toHaveLength(2);
    expect(container.querySelectorAll(".chart-point")).toHaveLength(4);
    const tickLabels = [...container.querySelectorAll(".chart-x-tick")].map((tick) => tick.textContent ?? "");
    expect(tickLabels).toHaveLength(5);
    tickLabels.forEach((label) => expect(label).toMatch(/^\d{2}:\d{2}$/));
  });

  it("detects a datetime xcolumn on a linechart and avoids overlapping raw timestamps", () => {
    const { container } = render(
      <ChartViewer
        directive={directive("linechart", { xcolumn: "_time", ycolumns: "avg_ms" })}
        rows={[
          { _time: "2026-07-23T00:00:00Z", avg_ms: 120 },
          { _time: "2026-07-23T00:15:00Z", avg_ms: 140 },
          { _time: "2026-07-23T00:30:00Z", avg_ms: 110 },
        ]}
      />,
    );

    const tickLabels = [...container.querySelectorAll(".chart-x-tick")].map((tick) => tick.textContent ?? "");
    expect(tickLabels).toHaveLength(5);
    tickLabels.forEach((label) => {
      expect(label).toMatch(/^\d{2}:\d{2}$/);
      expect(label).not.toContain("2026-07-23");
    });
  });

  it("centers categorical x-axis labels beneath their columns", () => {
    const { container } = render(
      <ChartViewer
        directive={directive("columnchart", { xcolumn: "level", ycolumns: "logs" })}
        rows={[
          { level: "fatal", service: "api", logs: 12 },
          { level: "notice", service: "api", logs: 8 },
        ]}
      />,
    );

    const ticks = [...container.querySelectorAll<SVGTextElement>(".chart-x-tick")];
    const bars = [...container.querySelectorAll<SVGRectElement>(".chart-bar")];
    expect(ticks.map((tick) => tick.textContent)).toEqual(["fatal", "notice"]);
    expect(ticks).toHaveLength(bars.length);
    ticks.forEach((tick, index) => {
      const bar = bars[index];
      const tickX = Number(tick.getAttribute("x"));
      const barCenter = Number(bar.getAttribute("x")) + Number(bar.getAttribute("width")) / 2;
      expect(Math.abs(tickX - barCenter)).toBeLessThanOrEqual(1);
    });
  });

  it("renders pie slices using the first category and numeric measure", () => {
    const { container } = render(
      <ChartViewer
        directive={directive("piechart")}
        rows={[
          { level: "error", total: 12 },
          { level: "warning", total: 8 },
        ]}
      />,
    );

    expect(screen.getByRole("img", { name: "piechart visualization" })).toBeInTheDocument();
    expect(container.querySelectorAll(".chart-slice")).toHaveLength(2);
    expect(screen.getByText("error")).toBeInTheDocument();
    expect(screen.getByText("warning")).toBeInTheDocument();
  });

  it("shows a useful error for a recognized but unsupported render kind", () => {
    render(<ChartViewer directive={directive("treemap")} rows={[{ name: "api", total: 3 }]} />);

    expect(screen.getByText("Unable to render visualization")).toBeInTheDocument();
    expect(screen.getByText(/“treemap” is not supported/)).toBeInTheDocument();
  });
});
