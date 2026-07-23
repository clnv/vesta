const SVG_STYLE_PROPERTIES = [
  "fill",
  "fill-opacity",
  "stroke",
  "stroke-width",
  "stroke-dasharray",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-opacity",
  "opacity",
  "font-family",
  "font-size",
  "font-style",
  "font-weight",
  "letter-spacing",
  "text-anchor",
  "dominant-baseline",
  "vector-effect",
];

function inlineSVGStyles(source: SVGSVGElement, target: SVGSVGElement) {
  const sourceNodes = [source, ...source.querySelectorAll<SVGElement>("*")];
  const targetNodes = [target, ...target.querySelectorAll<SVGElement>("*")];
  sourceNodes.forEach((node, index) => {
    const targetNode = targetNodes[index];
    if (!targetNode) return;
    const computed = getComputedStyle(node);
    SVG_STYLE_PROPERTIES.forEach((property) => {
      const value = computed.getPropertyValue(property);
      if (value) targetNode.style.setProperty(property, value);
    });
  });
}

function imageFromBlob(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const url = URL.createObjectURL(blob);
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("The chart image could not be rendered."));
    };
    image.src = url;
  });
}

function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("The chart image could not be encoded."));
    }, "image/png");
  });
}

interface LegendItem {
  label: string;
  color: string;
  width: number;
}

export async function chartElementToPNG(chart: HTMLElement): Promise<Blob> {
  const svg = chart.querySelector<SVGSVGElement>("svg.chart-svg");
  if (!svg) throw new Error("This visualization cannot be copied as an image.");

  const viewBox = svg.viewBox.baseVal;
  const width = viewBox.width || 960;
  const svgHeight = viewBox.height || 430;
  const title = chart.querySelector<HTMLElement>(".chart-title");
  const legend = chart.querySelector<HTMLElement>(".chart-legend");
  const legendSpans = legend ? [...legend.querySelectorAll<HTMLElement>("span")] : [];
  const backgroundColor = getComputedStyle(chart).backgroundColor || "#ffffff";

  const measureCanvas = document.createElement("canvas");
  const measure = measureCanvas.getContext("2d");
  if (!measure) throw new Error("Canvas rendering is not available.");
  const legendStyle = legend ? getComputedStyle(legend) : null;
  const legendFont = legendStyle
    ? `${legendStyle.fontWeight} ${legendStyle.fontSize} ${legendStyle.fontFamily}`
    : "12px monospace";
  measure.font = legendFont;
  const legendItems: LegendItem[] = legendSpans.map((item) => ({
    label: item.textContent?.trim() || "",
    color: getComputedStyle(item.querySelector("i") ?? item).backgroundColor,
    width: 14 + measure.measureText(item.textContent?.trim() || "").width + 18,
  }));

  const horizontalPadding = 18;
  const titleHeight = title ? 31 : 0;
  const legendRowHeight = 20;
  let legendRows = legendItems.length > 0 ? 1 : 0;
  let legendX = horizontalPadding;
  legendItems.forEach((item) => {
    if (legendX + item.width > width - horizontalPadding && legendX > horizontalPadding) {
      legendRows += 1;
      legendX = horizontalPadding;
    }
    legendX += item.width;
  });
  const headerHeight = titleHeight + legendRows * legendRowHeight + (title || legendRows ? 8 : 0);
  const outputHeight = svgHeight + headerHeight;
  const scale = 2;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(outputHeight * scale);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas rendering is not available.");
  context.scale(scale, scale);
  context.fillStyle = backgroundColor;
  context.fillRect(0, 0, width, outputHeight);

  let headerY = 0;
  if (title) {
    const style = getComputedStyle(title);
    context.fillStyle = style.color;
    context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    context.textBaseline = "top";
    context.fillText(title.textContent?.trim() || "", horizontalPadding, 5);
    headerY += titleHeight;
  }
  if (legendItems.length > 0) {
    context.font = legendFont;
    context.textBaseline = "middle";
    context.fillStyle = legendStyle?.color || "#64748b";
    let x = horizontalPadding;
    let y = headerY + legendRowHeight / 2;
    legendItems.forEach((item) => {
      if (x + item.width > width - horizontalPadding && x > horizontalPadding) {
        x = horizontalPadding;
        y += legendRowHeight;
      }
      context.fillStyle = item.color;
      context.fillRect(x, y - 4, 8, 8);
      context.fillStyle = legendStyle?.color || "#64748b";
      context.fillText(item.label, x + 14, y);
      x += item.width;
    });
  }

  const clone = svg.cloneNode(true) as SVGSVGElement;
  inlineSVGStyles(svg, clone);
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.setAttribute("width", String(width));
  clone.setAttribute("height", String(svgHeight));
  const serialized = new XMLSerializer().serializeToString(clone);
  const image = await imageFromBlob(new Blob([serialized], { type: "image/svg+xml;charset=utf-8" }));
  context.drawImage(image, 0, headerHeight, width, svgHeight);
  return canvasBlob(canvas);
}

export function blobToDataURL(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("The chart image could not be read."));
    reader.readAsDataURL(blob);
  });
}
