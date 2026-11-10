package server

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const testPixel = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII="

func isolatedServer(t *testing.T, choose func(string) (string, error)) *Server {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	t.Setenv("CUSTOM_PROVIDER_BASE_URL", "")
	t.Setenv("CUSTOM_PROVIDER_API_KEY", "")
	t.Setenv("AZURE_API_KEY", "")
	directory := t.TempDir()
	backend, err := New(Config{DataDir: filepath.Join(directory, "data"), MediaDir: filepath.Join(directory, "media"), Version: "test", ChooseConfigPath: choose})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = backend.Close() })
	return backend
}

func testAPI(t *testing.T, backend *Server, method, path string, fields any) (int, Object) {
	t.Helper()
	request := httptest.NewRequest(method, "http://localhost"+path, strings.NewReader(jsonText(fields)))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Helios-UI", "1")
	response := httptest.NewRecorder()
	backend.ServeHTTP(response, request)
	var result Object
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatalf("%s: %s", path, response.Body.String())
	}
	return response.Code, result
}

func mustAPI(t *testing.T, backend *Server, method, path string, fields any) Object {
	t.Helper()
	status, result := testAPI(t, backend, method, path, fields)
	if status != 200 {
		t.Fatalf("%s %s: %d %v", method, path, status, result)
	}
	return result
}

func testProvider(id, base, protocol string) Object {
	return Object{"id": id, "name": id, "baseUrl": base, "chatProtocol": protocol, "models": []any{Object{"id": "text", "name": "Vision alias", "apiId": "vision", "kind": "text", "enabled": true, "promptMaxLength": 32000}, Object{"id": "image", "name": "GPT Image", "apiId": "gpt-image-2.6-flare", "kind": "image", "enabled": true}}, "modelMap": Object{"custom-image": "gpt-image-2.6-flare"}}
}

func TestSharedAssetsLifecycle(t *testing.T) {
	backend := isolatedServer(t, nil)
	upload := mustAPI(t, backend, "POST", "/api/upload", Object{"dataUrl": "data:image/png;base64," + testPixel})
	location := text(upload["cdnUrl"])
	if number(mustAPI(t, backend, "GET", "/api/assets", nil)["total"]) != 1 {
		t.Fatal("legacy uploads without recorded MIME were not indexed")
	}
	thumbnail := httptest.NewRecorder()
	backend.ServeHTTP(thumbnail, httptest.NewRequest("GET", "http://localhost/_next/image?url="+location+"&w=256", nil))
	if thumbnail.Code != 200 || !strings.HasPrefix(thumbnail.Header().Get("Content-Type"), "image/") {
		t.Fatal("shared thumbnail compatibility route broken")
	}
	mustAPI(t, backend, "POST", "/api/upload", Object{"dataUrl": "data:image/png;base64," + testPixel})
	if err := backend.insertGeneration(Object{"id": "gen", "user_id": "guest", "task_id": "gen", "generation_type": "image", "status": "done", "image_url": location, "image_urls": []any{location, "/generated/second.png"}, "prompt": "shared cat", "model": "alias"}); err != nil {
		t.Fatal(err)
	}
	if err := backend.insertGeneration(Object{"id": "video", "user_id": "guest", "task_id": "video", "generation_type": "video", "status": "done", "video_url": "/generated/video.mp4"}); err != nil {
		t.Fatal(err)
	}
	list := mustAPI(t, backend, "GET", "/api/assets", nil)
	if number(list["total"]) != 3 {
		t.Fatalf("deduplicated assets: %v", list)
	}
	if number(mustAPI(t, backend, "GET", "/api/assets?type=video", nil)["total"]) != 1 {
		t.Fatal("video filter")
	}
	registered := mustAPI(t, backend, "POST", "/api/assets", Object{"url": location, "title": "cat.png"})
	id := registered["id"]
	mustAPI(t, backend, "PATCH", "/api/assets", Object{"id": id, "title": "产品参考", "tags": []any{"catalog", "cat"}, "favorite": true})
	filtered := mustAPI(t, backend, "GET", "/api/assets?q=catalog&favorite=true&type=image", nil)
	if number(filtered["total"]) != 1 || !truth(object(array(filtered["items"])[0])["favorite"]) {
		t.Fatal(filtered)
	}
	if number(mustAPI(t, backend, "GET", "/api/assets?limit=1&page=1", nil)["total"]) != 3 {
		t.Fatal("paging")
	}
	mustAPI(t, backend, "DELETE", "/api/assets", Object{"id": id})
	if number(mustAPI(t, backend, "GET", "/api/assets", nil)["total"]) != 2 {
		t.Fatal("hidden asset resurfaced during index")
	}
	if _, err := os.Stat(filepath.Join(backend.config.MediaDir, strings.TrimPrefix(location, "/generated/"))); err != nil {
		t.Fatal("library removal deleted original media", err)
	}
	if number(mustAPI(t, backend, "GET", "/api/gallery?type=image", nil)["total"]) != 1 {
		t.Fatal("library removal affected gallery")
	}
	other, err := New(Config{DataDir: backend.config.DataDir, MediaDir: backend.config.MediaDir})
	if err != nil {
		t.Fatal(err)
	}
	defer other.Close()
	if number(mustAPI(t, other, "GET", "/api/assets", nil)["total"]) != 2 {
		t.Fatal("hidden state did not survive reopen")
	}
	mustAPI(t, backend, "POST", "/api/assets", Object{"url": location, "title": "restored.png"})
	if number(mustAPI(t, backend, "GET", "/api/assets", nil)["total"]) != 3 {
		t.Fatal("explicit reimport did not restore asset")
	}
	if status, _ := testAPI(t, backend, "POST", "/api/assets", Object{"url": "https://untrusted.test/a.png", "title": "external"}); status != 400 {
		t.Fatal("unregistered URL accepted")
	}
}

func TestConfigTransferRoundTrip(t *testing.T) {
	source := isolatedServer(t, nil)
	config := testProvider("portable", "https://example.com/v1", "responses")
	mustAPI(t, source, "POST", "/api/settings/provider", Object{"config": config, "apiKey": "mock-secret"})
	preferences := Object{"aiui-model-providers": `{"custom-image":"custom"}`, "aiui-azure-endpoints": `{"image":"my-deployment"}`, "heliosgen-theme": "light"}
	exported := mustAPI(t, source, "POST", "/api/settings/transfer", Object{"action": "export", "preferences": preferences})
	backup := object(exported["backup"])
	if strings.Contains(jsonText(backup), "mock-secret") {
		t.Fatal("default export leaked API key")
	}
	if strings.Contains(jsonText(mustAPI(t, source, "GET", "/api/settings/provider", nil)), "mock-secret") {
		t.Fatal("export damaged public key redaction")
	}
	if text(object(array(object(backup["registry"])["providers"])[0])["apiKey"]) != "" {
		t.Fatal("keys must be omitted")
	}
	target := isolatedServer(t, nil)
	preview := mustAPI(t, target, "POST", "/api/settings/transfer", Object{"action": "preview", "backup": backup})
	if number(preview["models"]) != 2 || number(preview["keys"]) != 0 {
		t.Fatal(preview)
	}
	before := mustAPI(t, target, "GET", "/api/settings/provider", nil)
	if len(array(before["providers"])) != 0 {
		t.Fatal("preview changed configuration")
	}
	result := mustAPI(t, target, "POST", "/api/settings/transfer", Object{"action": "import", "backup": backup, "mode": "replace"})
	if jsonText(result["preferences"]) != jsonText(preferences) {
		t.Fatal("frontend settings dropped")
	}
	providers := mustAPI(t, target, "GET", "/api/settings/provider", nil)
	actual := object(array(providers["providers"])[0])
	if truth(actual["hasKey"]) || jsonText(actual["config"]) != jsonText(object(array(object(backup["registry"])["providers"])[0])["config"]) {
		t.Fatal("keyless registry round-trip differs")
	}
	mustAPI(t, target, "POST", "/api/settings/provider", Object{"config": config, "apiKey": "target-key"})
	mustAPI(t, target, "POST", "/api/settings/provider", Object{"config": testProvider("unrelated", "https://example.org/v1", "anthropic"), "apiKey": "other-key"})
	mustAPI(t, target, "POST", "/api/settings/transfer", Object{"action": "import", "backup": backup, "mode": "merge"})
	registry, _ := target.registry()
	if len(array(registry["providers"])) != 2 || text(object(array(registry["providers"])[0])["apiKey"]) != "target-key" {
		t.Fatal("merge lost local key or unrelated provider")
	}
	withKeys := object(mustAPI(t, source, "POST", "/api/settings/transfer", Object{"action": "export", "includeKeys": true})["backup"])
	if !strings.Contains(jsonText(withKeys), "mock-secret") {
		t.Fatal("explicit key export failed")
	}
	preview = mustAPI(t, target, "POST", "/api/settings/transfer", Object{"action": "preview", "backup": withKeys})
	if strings.Contains(jsonText(preview), "mock-secret") || number(preview["keys"]) != 1 {
		t.Fatal("preview leaked secret or key count wrong")
	}
	mustAPI(t, target, "POST", "/api/settings/transfer", Object{"action": "import", "backup": withKeys, "mode": "replace"})
	registry, _ = target.registry()
	if len(array(registry["providers"])) != 1 || text(object(array(registry["providers"])[0])["apiKey"]) != "mock-secret" {
		t.Fatal("explicit key import failed")
	}
	for _, change := range []Object{{"version": 99}, {"format": "bad"}, {"preferences": Object{"codex-token": "no"}}, {"preferences": Object{"heliosgen-theme": "bad"}}, {"registry": Object{"activeId": "missing", "providers": []any{}}}} {
		invalid := clone(backup)
		for key, value := range change {
			invalid[key] = value
		}
		before := target.setting("custom_provider_registry")
		if status, _ := testAPI(t, target, "POST", "/api/settings/transfer", Object{"action": "import", "backup": invalid, "mode": "replace"}); status != 400 {
			t.Fatalf("invalid import accepted: %v", change)
		}
		if before != target.setting("custom_provider_registry") {
			t.Fatal("failed validation partially mutated registry")
		}
	}
	request := httptest.NewRequest("POST", "http://localhost/api/settings/transfer", strings.NewReader(`{"action":"export","includeKeys":true}`))
	response := httptest.NewRecorder()
	target.ServeHTTP(response, request)
	if response.Code != 403 {
		t.Fatal("missing UI header accepted")
	}
	if _, err := target.db.Exec("CREATE TRIGGER fail_azure BEFORE INSERT ON settings WHEN NEW.key='azure_api_key' BEGIN SELECT RAISE(ABORT,'test failure'); END"); err != nil {
		t.Fatal(err)
	}
	beforeRegistry := target.setting("custom_provider_registry")
	if status, _ := testAPI(t, target, "POST", "/api/settings/transfer", Object{"action": "import", "backup": withKeys, "mode": "replace"}); status != 500 {
		t.Fatal("transaction error not reported", status)
	}
	if target.setting("custom_provider_registry") != beforeRegistry {
		t.Fatal("transaction failure did not roll back")
	}
}

func TestNativeConfigSaveAndCancel(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "chosen.json")
	cancelled := true
	backend := isolatedServer(t, func(name string) (string, error) {
		if !strings.HasSuffix(name, ".json") {
			t.Fatal("invalid suggested filename")
		}
		if cancelled {
			return "", nil
		}
		return path, nil
	})
	if !truth(mustAPI(t, backend, "GET", "/api/settings/transfer", nil)["nativeSave"]) {
		t.Fatal("native capability unavailable")
	}
	result := mustAPI(t, backend, "POST", "/api/settings/transfer", Object{"action": "export", "native": true})
	if !truth(result["cancelled"]) {
		t.Fatal("cancellation not reported")
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("cancel wrote a file")
	}
	cancelled = false
	mustAPI(t, backend, "POST", "/api/settings/provider", Object{"config": testProvider("native", "https://example.com/v1", "openai"), "apiKey": "private-key"})
	result = mustAPI(t, backend, "POST", "/api/settings/transfer", Object{"action": "export", "native": true, "includeKeys": true, "path": "/should-never-be-used"})
	if !truth(result["saved"]) || result["path"] != path {
		t.Fatal("native selected path ignored")
	}
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatal("export is not private", err)
	}
	encoded, _ := os.ReadFile(path)
	if !bytes.Contains(encoded, []byte("private-key")) {
		t.Fatal("saved contents incorrect")
	}
	files, _ := os.ReadDir(directory)
	if len(files) != 1 {
		t.Fatal("temporary files leaked")
	}
}

func TestChatAssetProtocols(t *testing.T) {
	for _, protocol := range []string{"openai", "responses", "anthropic", "gemini", "azure"} {
		t.Run(protocol, func(t *testing.T) {
			var sent Object
			mock := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
				_ = json.NewDecoder(request.Body).Decode(&sent)
				response.Header().Set("Content-Type", "text/event-stream")
				_, _ = response.Write([]byte("data: [DONE]\n\n"))
			}))
			defer mock.Close()
			backend := isolatedServer(t, nil)
			pixel, _ := base64.StdEncoding.DecodeString(testPixel)
			location, err := backend.uploadBuffer(pixel, "image/png", "uploads")
			if err != nil {
				t.Fatal(err)
			}
			selected := "provider-model:vision:text"
			if protocol != "azure" {
				mustAPI(t, backend, "POST", "/api/settings/provider", Object{"config": testProvider("vision", mock.URL+"/v1", protocol), "apiKey": "mock"})
			} else {
				selected = "azure-auto"
				_ = backend.setSetting("azure_api_key", "mock")
			}
			fields := Object{"model": selected, "messages": []any{Object{"role": "system", "content": "help"}, Object{"role": "user", "content": "describe", "imageUrls": []any{location}}, Object{"role": "assistant", "content": "a cat"}}, "azureEndpoint": mock.URL}
			request := httptest.NewRequest("POST", "http://localhost/api/assistant", strings.NewReader(jsonText(fields)))
			response := httptest.NewRecorder()
			backend.ServeHTTP(response, request)
			if response.Code != 200 {
				t.Fatal(response.Code, response.Body.String())
			}
			encoded := jsonText(sent)
			if strings.Contains(encoded, "/generated/") || strings.Contains(encoded, "imageUrls") {
				t.Fatal("machine-local paths or internal fields sent upstream")
			}
			switch protocol {
			case "responses":
				if !strings.Contains(encoded, "input_image") || !strings.Contains(encoded, "input_text") {
					t.Fatal(encoded)
				}
			case "anthropic":
				if !strings.Contains(encoded, `"media_type":"image/png"`) || !strings.Contains(encoded, `"system":"help"`) {
					t.Fatal(encoded)
				}
			case "gemini":
				if !strings.Contains(encoded, "inlineData") || !strings.Contains(encoded, "systemInstruction") {
					t.Fatal(encoded)
				}
			default:
				if !strings.Contains(encoded, "image_url") || !strings.Contains(encoded, "data:image/png;base64,") {
					t.Fatal(encoded)
				}
			}
		})
	}
}

func TestChatAssetValidation(t *testing.T) {
	backend := isolatedServer(t, nil)
	for _, message := range []Object{
		{"role": "user", "content": "test", "imageUrls": "bad"},
		{"role": "system", "content": "test", "imageUrls": []any{"data:image/png;base64," + testPixel}},
		{"role": "user", "content": "test", "imageUrls": []any{"http://127.0.0.1:1/internal"}},
		{"role": "user", "content": "test", "imageUrls": []any{"data:image/png;base64,aGVsbG8="}},
		{"role": "user", "content": "test", "imageUrls": []any{"/generated/../../outside.png"}},
	} {
		status, _ := testAPI(t, backend, "POST", "/api/assistant", Object{"messages": []any{message}})
		if status != 400 {
			t.Fatal("unsafe or invalid attachment accepted", status, message)
		}
	}
}
