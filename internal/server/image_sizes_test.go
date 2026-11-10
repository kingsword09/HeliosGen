package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func TestImagePresetSizesReachProvider(test *testing.T) {
	backend := isolatedServer(test, nil)
	received := make(chan Object, 1)
	provider := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		fields := Object{"path": request.URL.Path}
		if strings.HasPrefix(request.Header.Get("Content-Type"), "multipart/") {
			if err := request.ParseMultipartForm(1 << 20); err != nil {
				fields["parseError"] = err.Error()
			} else {
				defer request.MultipartForm.RemoveAll()
				for key := range request.MultipartForm.Value {
					fields[key] = request.FormValue(key)
				}
				fields["referenceCount"] = len(request.MultipartForm.File["image[]"])
			}
		} else {
			if err := json.NewDecoder(request.Body).Decode(&fields); err != nil {
				fields["parseError"] = err.Error()
			}
			fields["path"] = request.URL.Path
		}
		received <- fields
		response.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(response).Encode(Object{"data": []any{Object{"b64_json": testPixel}}})
	}))
	defer provider.Close()
	reference := text(mustAPI(test, backend, "POST", "/api/upload", Object{"dataUrl": "data:image/png;base64," + testPixel})["cdnUrl"])
	sizes := []struct {
		ratio string
		size  string
	}{
		{"1:1", "1024x1024"}, {"16:9", "1536x864"}, {"9:16", "864x1536"},
		{"3:2", "1536x1024"}, {"2:3", "1024x1536"}, {"3:4", "1152x1536"}, {"4:3", "1536x1152"},
	}
	for _, scenario := range []struct {
		apiID  string
		preset string
	}{
		{"gpt-image-2", "auto"},
		{"gpt-image-2.5-flare", "auto"},
		{"provider-flare-alias", "openai:gpt-image-2.6-extended"},
	} {
		test.Run(scenario.apiID, func(test *testing.T) {
			model := defaultModel("image", scenario.apiID)
			model["id"], model["parameterPreset"] = "image", scenario.preset
			mustAPI(test, backend, "POST", "/api/settings/provider", Object{"config": Object{"id": "size-test", "name": "Mock sizes", "baseUrl": provider.URL + "/v1", "imageProtocol": "openai", "models": []any{model}}, "apiKey": "mock-only"})
			selected := "provider-model:size-test:image"
			config, err := backend.configured(selected, "image")
			if err != nil {
				test.Fatal(err)
			}
			for _, dimensions := range sizes {
				for _, editing := range []bool{false, true} {
					input := Object{"model": selected, "prompt": "isolated size test", "aspectRatio": dimensions.ratio, "quality": "high"}
					path := "/v1/images/generations"
					if editing {
						input["imageUrls"] = []any{reference}
						path = "/v1/images/edits"
					}
					if _, err := backend.providerGeneration(context.Background(), config, "image", input); err != nil {
						test.Fatalf("%s (%s): %v", dimensions.ratio, path, err)
					}
					fields := <-received
					if fields["parseError"] != nil || fields["model"] != scenario.apiID || fields["size"] != dimensions.size || fields["path"] != path || fields["quality"] != "high" {
						test.Fatalf("%s: wrong upstream fields: %v", dimensions.ratio, fields)
					}
					if editing && fields["referenceCount"] != 1 {
						test.Fatalf("reference image lost: %v", fields)
					}
				}
			}
		})
	}
}

func TestStandardImageSizeRejectsUnsupportedRatio(test *testing.T) {
	model := defaultModel("image", "gpt-image-2.6-flare")
	model["parameterPreset"] = "auto"
	resolved, err := resolveModelParameters(model, "openai")
	if err != nil {
		test.Fatal(err)
	}
	config := Object{"imageProtocol": "openai", "models": []any{resolved}}
	if _, err := prepareInput(config, "image", Object{"model": "gpt-image-2.6-flare", "aspectRatio": "16:9"}); err == nil {
		test.Fatal("standard profile must reject unsupported ratios, not silently approximate them")
	}
}

func TestImageProviderSizeErrorDoesNotRetry(test *testing.T) {
	backend := isolatedServer(test, nil)
	var calls atomic.Int32
	received := make(chan Object, 2)
	provider := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		calls.Add(1)
		fields := Object{}
		_ = json.NewDecoder(request.Body).Decode(&fields)
		received <- fields
		response.Header().Set("Content-Type", "application/json")
		response.WriteHeader(http.StatusBadRequest)
		_ = json.NewEncoder(response).Encode(Object{"error": Object{"message": "unsupported size"}})
	}))
	defer provider.Close()
	model := defaultModel("image", "gpt-image-2.6-flare")
	model["id"], model["parameterPreset"] = "image", "openai:gpt-image-2.6-extended"
	mustAPI(test, backend, "POST", "/api/settings/provider", Object{"config": Object{"id": "size-error", "name": "Mock restriction", "baseUrl": provider.URL + "/v1", "imageProtocol": "openai", "models": []any{model}}, "apiKey": "mock-only"})
	selected := "provider-model:size-error:image"
	config, err := backend.configured(selected, "image")
	if err != nil {
		test.Fatal(err)
	}
	if _, err := backend.providerGeneration(context.Background(), config, "image", Object{"model": selected, "prompt": "isolated rejection test", "aspectRatio": "16:9"}); err == nil {
		test.Fatal("provider size rejection must remain an error")
	}
	if calls.Load() != 1 {
		test.Fatalf("unsupported dimensions caused %d generation calls", calls.Load())
	}
	if fields := <-received; fields["size"] != "1536x864" {
		test.Fatalf("ratio was silently substituted: %v", fields)
	}
}
