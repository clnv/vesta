package victoria

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"

	"github.com/vesta-explorer/vesta/internal/config"
)

func TestFieldValuesUsesOnlyQueryScopedMetadataParameters(t *testing.T) {
	var form url.Values
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		form = r.PostForm
		_, _ = io.WriteString(w, `{"values":[]}`)
	}))
	defer server.Close()
	client := NewClient()
	response, err := client.Do(context.Background(), Request{
		Source:   config.SourceConfig{URL: server.URL},
		Tenant:   config.Tenant{AccountID: "0", ProjectID: "0"},
		Endpoint: "/select/logsql/field_values", Query: "_time:1h", Field: "host",
	})
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if form.Get("query") != "_time:1h" || form.Get("field") != "host" || form.Get("limit") != "200" {
		t.Fatalf("unexpected form: %v", form)
	}
	for _, forbidden := range []string{"start", "end", "offset", "extra_filters"} {
		if form.Has(forbidden) {
			t.Fatalf("unexpected parameter %q", forbidden)
		}
	}
}
