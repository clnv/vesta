package server

import (
	"fmt"
	"net/http"
	"sync/atomic"
)

type metrics struct {
	queries   atomic.Int64
	errors    atomic.Int64
	truncated atomic.Int64
	rows      atomic.Int64
	bytes     atomic.Int64
	active    atomic.Int64
}

func (m *metrics) handler(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "text/plain; version=0.0.4")
	fmt.Fprintf(w, "# TYPE vesta_queries_total counter\nvesta_queries_total %d\n", m.queries.Load())
	fmt.Fprintf(w, "# TYPE vesta_query_errors_total counter\nvesta_query_errors_total %d\n", m.errors.Load())
	fmt.Fprintf(w, "# TYPE vesta_query_truncated_total counter\nvesta_query_truncated_total %d\n", m.truncated.Load())
	fmt.Fprintf(w, "# TYPE vesta_rows_streamed_total counter\nvesta_rows_streamed_total %d\n", m.rows.Load())
	fmt.Fprintf(w, "# TYPE vesta_bytes_streamed_total counter\nvesta_bytes_streamed_total %d\n", m.bytes.Load())
	fmt.Fprintf(w, "# TYPE vesta_active_streams gauge\nvesta_active_streams %d\n", m.active.Load())
}
