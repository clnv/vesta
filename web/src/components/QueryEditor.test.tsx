import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryEditor } from "./QueryEditor";

describe("QueryEditor", () => {
  afterEach(() => {
    cleanup();
    document.querySelector('meta[name="csp-nonce"]')?.remove();
  });

  it("applies the page CSP nonce to CodeMirror's generated stylesheet", () => {
    const meta = document.createElement("meta");
    meta.name = "csp-nonce";
    meta.content = "test-csp-nonce";
    document.head.append(meta);

    render(
      <QueryEditor
        value="_time:1h"
        fields={[]}
        dark={false}
        onChange={vi.fn()}
        onRun={vi.fn()}
      />,
    );

    expect(document.head.querySelector('style[nonce="test-csp-nonce"]')).not.toBeNull();
  });
});
