package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"

	"heliosgen/internal/server"
)

type transport struct {
	mu     sync.Mutex
	failed map[string]bool
	calls  map[string]int
}

func (mock *transport) RoundTrip(request *http.Request) (*http.Response, error) {
	mock.mu.Lock()
	defer mock.mu.Unlock()
	host := request.URL.Hostname()
	mock.calls[host]++
	if mock.failed[host] {
		return nil, errors.New("offline")
	}
	var value any
	switch host {
	case "ai-gateway.vercel.sh":
		value = map[string]any{"data": []any{map[string]any{"id": "openai/text", "owned_by": "openai", "name": "Text", "type": "language", "modalities": map[string]any{"input": []any{"text"}, "output": []any{"text"}}}, map[string]any{"id": "black-forest/image", "owned_by": "black-forest", "name": "Image", "type": "image", "modalities": map[string]any{"output": []any{"image"}}}}}
	case "models.dev":
		value = map[string]any{"openai": map[string]any{"models": map[string]any{"text": map[string]any{"id": "text", "name": "Duplicate Text", "type": "language"}}}, "video-provider": map[string]any{"models": map[string]any{"video": map[string]any{"id": "video", "name": "Video", "modalities": map[string]any{"output": []any{"video"}}}}}}
	case "api.github.com":
		value = map[string]any{"tag_name": "v9.0.0", "name": "Update", "body": "Changes", "html_url": "https://github.com/SegFault42/HeliosGen/releases/tag/v9.0.0", "published_at": "2026-11-10T00:00:00Z"}
	case "api.replicate.com":
		if request.Method != "POST" || request.Header.Get("Authorization") != "Bearer temporary-replicate" || request.Header.Get("Prefer") != "wait=60" {
			return nil, errors.New("Replicate request lost required fields")
		}
		var payload map[string]any
		if err := json.NewDecoder(request.Body).Decode(&payload); err != nil {
			return nil, err
		}
		if payload["model"] != "black-forest-labs/flux-dev" {
			return nil, errors.New("Replicate model mapping changed")
		}
		value = map[string]any{"id": "replicate-test", "status": "succeeded", "output": []any{"https://replicate.delivery/image.png"}}
	case "azure.example.test":
		if request.Header.Get("api-key") != "temporary-azure" || request.URL.Path != "/openai/deployments/auto-model/chat/completions" || request.URL.Query().Get("api-version") != "2024-04-01-preview" {
			return nil, errors.New("Azure Auto connection contract changed")
		}
		var payload map[string]any
		if err := json.NewDecoder(request.Body).Decode(&payload); err != nil {
			return nil, err
		}
		if payload["model"] != "model-router" || payload["max_tokens"] != float64(8192) || payload["stream"] != true {
			return nil, errors.New("Azure Auto payload contract changed")
		}
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"text/event-stream"}}, Body: io.NopCloser(strings.NewReader("data: {\"choices\":[{\"delta\":{\"content\":\"Azure text\"}}]}\n\n")), Request: request}, nil
	default:
		return nil, fmt.Errorf("Unmocked upstream %s", request.URL)
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(bytes.NewReader(encoded)), Request: request}, nil
}

func main() {
	directory, err := os.MkdirTemp("", "helios-go-extra-")
	if err != nil {
		panic(err)
	}
	defer os.RemoveAll(directory)
	mock := &transport{failed: map[string]bool{}, calls: map[string]int{}}
	backend, err := server.New(server.Config{DataDir: directory, Version: "1.2.1", Client: &http.Client{Transport: mock}})
	if err != nil {
		panic(err)
	}
	defer backend.Close()
	assertions := 0
	check := func(valid bool, message string) {
		assertions++
		if !valid {
			panic(message)
		}
	}
	call := func(method, path string, payload any) (int, map[string]any) {
		var reader io.Reader
		if payload != nil {
			encoded, _ := json.Marshal(payload)
			reader = bytes.NewReader(encoded)
		}
		request := httptest.NewRequest(method, "http://127.0.0.1"+path, reader)
		response := httptest.NewRecorder()
		backend.ServeHTTP(response, request)
		var value map[string]any
		if err := json.Unmarshal(response.Body.Bytes(), &value); err != nil {
			panic(response.Body.String())
		}
		return response.Code, value
	}
	status, catalog := call("GET", "/api/settings/provider/model-catalog", nil)
	check(status == 200, "Catalog download")
	check(len(catalog["models"].([]any)) == 3, "Merged catalog must deduplicate canonical IDs")
	check(len(catalog["sources"].([]any)) == 2, "Both catalog sources retained")
	_, cached := call("GET", "/api/settings/provider/model-catalog", nil)
	check(len(cached["models"].([]any)) == 3, "Cached catalog")
	check(mock.calls["models.dev"] == 1, "Catalog TTL avoids repeat downloads")
	mock.failed["models.dev"] = true
	_, partial := call("GET", "/api/settings/provider/model-catalog?refresh=1", nil)
	check(partial["stale"] == true, "Partial failure keeps previous source")
	check(len(partial["models"].([]any)) == 3, "Unavailable-source cached models retained")
	mock.failed["ai-gateway.vercel.sh"] = true
	status, offline := call("GET", "/api/settings/provider/model-catalog?refresh=1", nil)
	check(status == 200 && offline["stale"] == true, "Offline catalog remains usable")
	status, update := call("GET", "/api/update-check", nil)
	check(status == 200 && update["updateAvailable"] == true, "Update check")
	check(update["currentVersion"] == "1.2.1", "Running build version")
	_, _ = call("GET", "/api/update-check", nil)
	check(mock.calls["api.github.com"] == 1, "Update cache")
	previous := os.Getenv("REPLICATE_API_TOKEN")
	_ = os.Setenv("REPLICATE_API_TOKEN", "temporary-replicate")
	defer os.Setenv("REPLICATE_API_TOKEN", previous)
	status, prediction := call("POST", "/api/generate-image", map[string]any{"model": "flux-dev", "prompt": "test"})
	check(status == 200 && prediction["imageUrl"] == "https://replicate.delivery/image.png", "Legacy Replicate success contract")
	status, _ = call("POST", "/api/settings/azure-key", map[string]any{"azureApiKey": "temporary-azure"})
	check(status == 200, "Azure Auto key configuration")
	azurePayload, _ := json.Marshal(map[string]any{"model": "azure-auto", "prompt": "test", "azureEndpoint": "https://azure.example.test/openai/"})
	azureRequest := httptest.NewRequest("POST", "http://127.0.0.1/api/assistant", bytes.NewReader(azurePayload))
	azureResponse := httptest.NewRecorder()
	backend.ServeHTTP(azureResponse, azureRequest)
	check(azureResponse.Code == 200 && strings.Contains(azureResponse.Body.String(), "Azure text"), "Azure Auto passthrough streaming")
	request := httptest.NewRequest("GET", "http://127.0.0.1/api/health", nil)
	request.Header.Set("Origin", "https://untrusted.example")
	response := httptest.NewRecorder()
	backend.ServeHTTP(response, request)
	check(response.Code == 403, "Remote-origin rejection")
	request = httptest.NewRequest("GET", "http://untrusted.example/api/health", nil)
	response = httptest.NewRecorder()
	backend.ServeHTTP(response, request)
	check(response.Code == 403, "DNS-rebinding host rejection")
	status, missing := call("GET", "/api/job-status", nil)
	check(status == 400 && missing["error"] == "taskId is required", "Missing task error")
	status, invalid := call("POST", "/api/settings/provider", map[string]any{"config": map[string]any{"id": "unsafe", "baseUrl": "https://example.test", "models": []any{map[string]any{"id": "model", "apiId": "model", "name": "model", "kind": "text", "connection": map[string]any{"authHeader": "X-Header\r\nInjected"}}}}})
	check(status == 400 && strings.Contains(fmt.Sprint(invalid["error"]), "字符串"), "Authentication header injection rejected")
	fmt.Printf("PASS: %d isolated catalog, cache, Replicate, Azure Auto, update and security assertions.\n", assertions)
}
