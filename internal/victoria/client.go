package victoria

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"

	"github.com/vesta-explorer/vesta/internal/config"
)

type Client struct{ HTTP *http.Client }

func NewClient() *Client {
	return &Client{HTTP: &http.Client{Transport: &http.Transport{
		Proxy:                 http.ProxyFromEnvironment,
		MaxIdleConns:          100,
		MaxIdleConnsPerHost:   20,
		ResponseHeaderTimeout: 30_000_000_000,
	}}}
}

type Request struct {
	Source   config.SourceConfig
	Tenant   config.Tenant
	Endpoint string
	Query    string
	Field    string
}

func (c *Client) Do(ctx context.Context, input Request) (*http.Response, error) {
	form := url.Values{"query": {input.Query}}
	if len(input.Source.HiddenFields) > 0 {
		patterns, err := json.Marshal(input.Source.HiddenFields)
		if err != nil {
			return nil, fmt.Errorf("encode hidden field policy: %w", err)
		}
		form.Set("hidden_fields_filters", string(patterns))
	}
	switch input.Endpoint {
	case "/select/logsql/query", "/select/logsql/tail", "/select/logsql/field_names":
	case "/select/logsql/field_values":
		if input.Field == "" {
			return nil, fmt.Errorf("field is required")
		}
		form.Set("field", input.Field)
		form.Set("limit", "200")
	default:
		return nil, fmt.Errorf("unsupported VictoriaLogs endpoint %q", input.Endpoint)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, input.Source.URL+input.Endpoint, strings.NewReader(form.Encode()))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json, application/x-ndjson")
	req.Header.Set("AccountID", input.Tenant.AccountID)
	req.Header.Set("ProjectID", input.Tenant.ProjectID)
	username, password, token := input.Source.Credentials()
	switch input.Source.Auth.Type {
	case "basic":
		req.SetBasicAuth(username, password)
	case "bearer":
		req.Header.Set("Authorization", "Bearer "+token)
	}
	return c.HTTP.Do(req)
}

func ReadError(response *http.Response) string {
	if response == nil || response.Body == nil {
		return "VictoriaLogs request failed"
	}
	contents, _ := io.ReadAll(io.LimitReader(response.Body, 64<<10))
	message := strings.TrimSpace(string(contents))
	if message == "" {
		message = response.Status
	}
	return message
}
