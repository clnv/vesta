import { autocompletion, type CompletionContext } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { HighlightStyle, StreamLanguage, syntaxHighlighting } from "@codemirror/language";
import { linter } from "@codemirror/lint";
import { EditorSelection, type Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import CodeMirror from "@uiw/react-codemirror";
import { forwardRef, useImperativeHandle, useMemo, useRef } from "react";
import { oneDark } from "@codemirror/theme-one-dark";
import { hasTimeFilter } from "../lib/logsql";

export interface QueryEditorHandle {
  executableQuery(): string;
  focus(): void;
}

interface Props {
  value: string;
  fields: string[];
  dark: boolean;
  onChange(value: string): void;
  onRun(query: string): void;
}

const language = StreamLanguage.define({
  startState: () => ({}),
  token(stream) {
    if (stream.match(/^#.*/)) return "comment";
    if (stream.match(/^"(?:[^"\\]|\\.)*"/)) return "string";
    if (stream.match(/^'(?:[^'\\]|\\.)*'/)) return "string";
    if (stream.match(/^-?\d+(?:\.\d+)?(?:ns|us|µs|ms|s|m|h|d|w|y)?\b/)) return "number";
    if (stream.match(/^\b(?:AND|OR|NOT|in|exact|contains_any|contains_all)\b/i)) return "operatorKeyword";
    if (stream.match(/^\b(?:fields|keep|delete|drop|rename|copy|filter|format|unpack_json|unpack_logfmt|unpack_syslog|stats|uniq|top|sort|limit|offset|first|last|sample|math|field_names|field_values|render|with)\b/)) return "keyword";
    if (stream.match(/^\b(?:anomalychart|areachart|barchart|card|columnchart|linechart|piechart|scatterchart|stackedareachart|table|timechart)\b/)) return "typeName";
    if (stream.match(/^\b(?:count|count_uniq|sum|max|min|avg|median|quantile|rate|row_max|row_min)\b/)) return "typeName";
    if (stream.match(/^_[A-Za-z0-9_.]+/)) return "variableName.special";
    if (stream.match(/^[A-Za-z][A-Za-z0-9_.-]*(?=\s*:)/)) return "propertyName";
    stream.next();
    return null;
  },
});

const highlights = syntaxHighlighting(HighlightStyle.define([
  { tag: tags.keyword, color: "var(--syntax-keyword)", fontWeight: "600" },
  { tag: tags.operatorKeyword, color: "var(--syntax-operator)" },
  { tag: tags.string, color: "var(--syntax-string)" },
  { tag: tags.number, color: "var(--syntax-number)" },
  { tag: tags.comment, color: "var(--syntax-comment)", fontStyle: "italic" },
  { tag: tags.propertyName, color: "var(--syntax-property)" },
  { tag: tags.special(tags.variableName), color: "var(--syntax-special)" },
  { tag: tags.typeName, color: "var(--syntax-function)" },
]));

const keywords = [
  "_time:5m", "_time:1h", "_time:24h", "_time:[2026-01-01Z, 2026-01-02Z)",
  "sort by (_time) desc", "limit 200", "fields _time, _stream, _msg", "stats count()",
  "stats by (_time:5m) count()", "count_uniq(_stream_id)", "filter", "format", "unpack_json",
  "render timechart", "render linechart", "render areachart", "render columnchart",
  "render barchart", "render piechart", "render scatterchart", "render card",
];

export const QueryEditor = forwardRef<QueryEditorHandle, Props>(function QueryEditor({ value, fields, dark, onChange, onRun }, ref) {
  const viewRef = useRef<EditorView | null>(null);
  useImperativeHandle(ref, () => ({
    executableQuery: () => {
      const view = viewRef.current;
      if (!view) return value;
      const selection = view.state.selection.main;
      return selection.empty ? view.state.doc.toString() : view.state.sliceDoc(selection.from, selection.to);
    },
    focus: () => viewRef.current?.focus(),
  }), [value]);

  const extensions = useMemo<Extension[]>(() => {
    const completion = (context: CompletionContext) => {
      const word = context.matchBefore(/[A-Za-z0-9_.:-]*/);
      if (!word || (word.from === word.to && !context.explicit)) return null;
      return {
        from: word.from,
        options: [
          ...keywords.map((label) => ({ label, type: "keyword" })),
          ...fields.map((label) => ({ label, type: "property" })),
        ],
      };
    };
    return [
      language,
      highlights,
      history(),
      keymap.of([
        { key: "Shift-Enter", run: (view) => {
          const selection = view.state.selection.main;
          onRun(selection.empty ? view.state.doc.toString() : view.state.sliceDoc(selection.from, selection.to));
          return true;
        } },
        indentWithTab,
        ...defaultKeymap,
        ...historyKeymap,
      ]),
      autocompletion({ override: [completion], activateOnTyping: true }),
      linter((view) => hasTimeFilter(view.state.doc.toString()) ? [] : [{
        from: 0,
        to: Math.min(1, view.state.doc.length),
        severity: "error",
        message: "Add an explicit _time: filter. Vesta never injects a hidden time range.",
      }]),
      EditorView.lineWrapping,
      EditorView.theme({
        "&": { height: "100%", background: "transparent" },
        ".cm-scroller": { fontFamily: "var(--font-mono)", fontSize: "13px", lineHeight: "1.7" },
        ".cm-content": { padding: "14px 8px" },
        ".cm-gutters": { background: "transparent", border: "none", color: "var(--text-faint)" },
        ".cm-activeLine, .cm-activeLineGutter": { background: "var(--editor-active-line)" },
        ".cm-selectionBackground, ::selection": { background: "var(--selection) !important" },
        ".cm-focused": { outline: "none" },
        ".cm-tooltip": { border: "1px solid var(--border)", background: "var(--surface-elevated)" },
      }),
      ...(dark ? [oneDark] : []),
    ];
  }, [dark, fields, onRun]);

  return (
    <CodeMirror
      value={value}
      height="100%"
      extensions={extensions}
      onChange={onChange}
      onCreateEditor={(view) => { viewRef.current = view; }}
      onUpdate={(update) => {
        if (update.selectionSet && update.state.selection.main.empty && update.state.selection.main.anchor > update.state.doc.length) {
          update.view.dispatch({ selection: EditorSelection.cursor(update.state.doc.length) });
        }
      }}
      basicSetup={{ lineNumbers: true, foldGutter: false, highlightActiveLine: true, autocompletion: false, lintKeymap: true }}
    />
  );
});
