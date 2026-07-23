package logsql

import "testing"

func TestHasTimeFilter(t *testing.T) {
	tests := []struct {
		name  string
		query string
		want  bool
	}{
		{"relative", `_time:1h error`, true},
		{"space before colon", `_time : [2026-01-01Z, 2026-01-02Z)`, true},
		{"nested", `host:in(_time:1d | keep host)`, true},
		{"comment", "error # _time:1h\n | limit 2", false},
		{"double quote", `"_time:1h"`, false},
		{"single quote", `'_time:1h'`, false},
		{"field output", `_time | fields _time, _msg`, false},
		{"other identifier", `foo_time:1h`, false},
		{"escaped quote", `"message \" _time:1h"`, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := HasTimeFilter(tt.query); got != tt.want {
				t.Fatalf("HasTimeFilter(%q) = %v, want %v", tt.query, got, tt.want)
			}
		})
	}
}

func TestWithoutRenderOperator(t *testing.T) {
	tests := []struct {
		name  string
		query string
		want  string
	}{
		{
			name:  "timechart",
			query: "_time:1h | stats by (_time:5m) count() | render timechart",
			want:  "_time:1h | stats by (_time:5m) count()",
		},
		{
			name:  "properties containing pipe",
			query: `_time:1h | stats count() | render card with (title="Errors | total")`,
			want:  "_time:1h | stats count()",
		},
		{
			name:  "comment",
			query: "_time:1h | limit 10 # | render piechart",
			want:  "_time:1h | limit 10 # | render piechart",
		},
		{
			name:  "non terminal",
			query: "_time:1h | render timechart | limit 10",
			want:  "_time:1h | render timechart | limit 10",
		},
		{
			name:  "string",
			query: `_time:1h _msg:"| render piechart" | limit 10`,
			want:  `_time:1h _msg:"| render piechart" | limit 10`,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := WithoutRenderOperator(test.query); got != test.want {
				t.Fatalf("WithoutRenderOperator() = %q, want %q", got, test.want)
			}
		})
	}
}
