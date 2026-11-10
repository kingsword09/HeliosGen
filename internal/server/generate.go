package server

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"
	"unicode/utf16"
)

func azureEnvironmentKey() string { return os.Getenv("AZURE_API_KEY") }
func truncateUTF16(value string, limit int) string {
	encoded := utf16.Encode([]rune(value))
	if len(encoded) > limit {
		encoded = encoded[:limit]
		if len(encoded) > 0 && encoded[len(encoded)-1] >= 0xD800 && encoded[len(encoded)-1] <= 0xDBFF {
			encoded = encoded[:len(encoded)-1]
		}
	}
	return string(utf16.Decode(encoded))
}

func validateURLs(value any) ([]any, error) {
	if value == nil {
		return []any{}, nil
	}
	entries, valid := value.([]any)
	if !valid {
		return nil, bad("Reference media must be an array of URL strings.")
	}
	for _, entry := range entries {
		if _, valid := entry.(string); !valid {
			return nil, bad("Reference media must be an array of URL strings.")
		}
	}
	return entries, nil
}

func (backend *Server) generate(request *http.Request) (any, error) {
	if err := method(request, "POST"); err != nil {
		return nil, err
	}
	fields, err := body(request)
	if err != nil {
		return nil, err
	}
	if truth(fields["debugOnly"]) {
		return Object{"ok": true}, nil
	}
	if request.URL.Path == "/api/generate-image" {
		return backend.replicateImage(request.Context(), fields)
	}
	if request.URL.Path == "/api/generate-video" {
		selected := text(fallback(fields["videoModel"], fallback(fields["model"], "custom-video")))
		prompt, valid := fallback(fields["prompt"], "").(string)
		if !valid {
			return nil, bad("Model and prompt must be strings.")
		}
		if fields["duration"] != nil && (number(fields["duration"]) <= 0 || math.IsNaN(number(fields["duration"]))) {
			return nil, bad("Duration must be a positive number.")
		}
		config, err := backend.configured(selected, "video")
		if err != nil {
			return nil, bad(err.Error())
		}
		references, err := validateURLs(fallback(fields["referenceImageUrls"], fields["imageUrls"]))
		if err != nil {
			return nil, err
		}
		for _, entry := range array(fields["resources"]) {
			if location, ok := object(entry)["url"].(string); ok {
				references = append(references, location)
			}
		}
		for _, entry := range array(fields["klingElements"]) {
			locations, err := validateURLs(object(entry)["imageUrls"])
			if err != nil {
				return nil, err
			}
			references = append(references, locations...)
		}
		videos, err := validateURLs(fields["referenceVideoUrls"])
		if err != nil {
			return nil, err
		}
		audio, err := validateURLs(fields["referenceAudioUrls"])
		if err != nil {
			return nil, err
		}
		input := Object{"model": selected, "prompt": prompt, "imageUrls": references, "aspectRatio": fallback(fields["aspectRatio"], fields["aspect_ratio"]), "duration": fields["duration"], "resolution": fields["resolution"], "startFrameUrl": fields["startFrameUrl"], "endFrameUrl": fields["endFrameUrl"], "videoRefUrl": fields["videoRefUrl"], "referenceVideoUrls": videos, "referenceAudioUrls": audio}
		if fields["duration"] != nil {
			input["duration"] = number(fields["duration"])
		}
		if fields["sound"] != nil {
			input["sound"] = truth(fields["sound"])
		}
		input, err = prepareInput(config, "video", input)
		if err != nil {
			return nil, bad(err.Error())
		}
		metadata := Object{"user_id": "guest", "model": selected, "prompt": prompt, "aspect_ratio": fallback(input["aspectRatio"], "auto"), "duration": input["duration"], "sound": input["sound"], "reference_image_urls": references}
		id, err := backend.startProviderJob("video", config, input, metadata)
		return Object{"taskId": id}, err
	}
	return backend.generateImage(request.Context(), fields)
}

type integrationTaskKey struct{}

func (backend *Server) generateImage(ctx context.Context, fields Object) (any, error) {
	prompt, valid := fields["prompt"].(string)
	if !valid || strings.TrimSpace(prompt) == "" {
		return nil, bad("Prompt is required")
	}
	selected := text(fallback(fields["model"], "custom-image"))
	references, err := validateURLs(fields["imageUrls"])
	if err != nil {
		return nil, bad("Reference images must be URL strings.")
	}
	mirrored := []any{}
	for index, entry := range references {
		if index >= 14 {
			break
		}
		location, err := backend.storeMedia(ctx, text(entry), "references")
		if err == nil {
			mirrored = append(mirrored, location)
		}
	}
	if truth(fields["azureBaseUrl"]) && truth(fields["azureDeployment"]) {
		return backend.startSpecialImage("azure", selected, prompt, mirrored, fields)
	}
	if truth(fields["codexProvider"]) {
		return backend.startSpecialImage("codex", selected, prompt, mirrored, fields)
	}
	config, err := backend.configured(selected, "image")
	if err != nil {
		return nil, bad(err.Error())
	}
	input, err := prepareInput(config, "image", Object{"model": selected, "prompt": prompt, "imageUrls": mirrored, "aspectRatio": fields["aspectRatio"], "quality": fields["quality"]})
	if err != nil {
		return nil, bad(err.Error())
	}
	metadata := Object{"user_id": "guest", "model": selected, "prompt": prompt, "aspect_ratio": fallback(input["aspectRatio"], "auto"), "quality": input["quality"], "reference_image_urls": references}
	if task, ok := ctx.Value(integrationTaskKey{}).(string); ok {
		metadata["task_id"] = task
	}
	id, err := backend.startProviderJob("image", config, input, metadata)
	return Object{"taskId": id}, err
}

func (backend *Server) imagePreset(selected string) Object {
	var presets []any
	_ = json.Unmarshal([]byte(legacyImageModelsJSON), &presets)
	for _, entry := range presets {
		fields := object(entry)
		if fields["id"] == selected {
			return fields
		}
	}
	if config, err := backend.configured(selected, "image"); err == nil {
		if definition, err := modelDefinition(config, "image", selected); err == nil && definition != nil {
			return Object{"maxImages": definition["maxImages"], "apiInput": Object{"promptMaxLength": definition["promptMaxLength"]}}
		}
	}
	return object(presets[0])
}

func (backend *Server) startSpecialImage(kind, selected, prompt string, references []any, fields Object) (any, error) {
	key := backend.setting("azure_api_key")
	if key == "" {
		key = azureEnvironmentKey()
	}
	if kind == "azure" && key == "" {
		return nil, errors.New("Azure API key is not configured. Add it in Settings.")
	}
	id := fmt.Sprintf("%s-%d-%s", kind, time.Now().UnixMilli(), uuid()[:6])
	if err := backend.setJob(id, Object{"status": "pending", "type": "image", "userId": "guest"}); err != nil {
		return nil, err
	}
	if !backend.claimJob(id) {
		return nil, errors.New("Server is shutting down")
	}
	preset := backend.imagePreset(selected)
	go func() {
		defer backend.releaseJob(id)
		ctx, cancel := context.WithCancel(backend.ctx)
		if kind == "azure" {
			cancel()
			ctx, cancel = context.WithTimeout(backend.ctx, 1000*time.Second)
		}
		defer cancel()
		var buffer []byte
		var err error
		if kind == "azure" {
			buffer, err = backend.azureImage(ctx, key, prompt, references, fields, preset)
		} else {
			buffer, err = backend.codexImage(ctx, prompt, references, fields, preset)
		}
		if backend.ctx.Err() != nil {
			return
		}
		if err != nil {
			backend.settle(id, Object{"status": "error", "error": err.Error()})
			return
		}
		location, err := backend.uploadBuffer(buffer, "image/png", "generated")
		if err != nil {
			backend.settle(id, Object{"status": "error", "error": err.Error()})
			return
		}
		quality := fallback(fields["quality"], "1k")
		if kind == "azure" {
			quality = fallback(fields["azureQuality"], "medium")
		}
		metadata := Object{"task_id": id, "user_id": "guest", "generation_type": "image", "status": "done", "image_url": location, "prompt": truncateUTF16(prompt, 2000), "model": selected, "aspect_ratio": fallback(fields["aspectRatio"], "1:1"), "quality": quality}
		if kind == "azure" {
			metadata["azure_resolution"] = fields["azureResolution"]
			if len(references) > 0 {
				metadata["reference_image_urls"] = references
			}
		}
		if err = backend.insertGeneration(metadata); err != nil {
			backend.settle(id, Object{"status": "error", "error": err.Error()})
			return
		}
		backend.settle(id, Object{"status": "done", "imageUrl": location})
	}()
	return Object{"taskId": id}, nil
}

func validAzureDimensions(width, height float64) bool {
	return width > 0 && height > 0 && width <= 3840 && height <= 3840 && math.Mod(width, 16) == 0 && math.Mod(height, 16) == 0 && max(width, height)/min(width, height) <= 3 && width*height >= 655360 && width*height <= 8294400
}

func (backend *Server) azureImage(ctx context.Context, key, prompt string, references []any, fields, preset Object) ([]byte, error) {
	ratio := text(fallback(fields["aspectRatio"], "1:1"))
	sizes := object(preset["azureSizeMap"])
	if resolution := object(object(preset["azureResolutionSizeMaps"])[text(fields["azureResolution"])]); len(resolution) > 0 {
		sizes = resolution
	}
	size := text(fallback(sizes[ratio], "1024x1024"))
	if ratio == "custom" && validAzureDimensions(number(fields["azureCustomWidth"]), number(fields["azureCustomHeight"])) {
		size = fmt.Sprintf("%dx%d", int(number(fields["azureCustomWidth"])), int(number(fields["azureCustomHeight"])))
	}
	quality := text(fields["azureQuality"])
	if quality == "" {
		quality = "medium"
	}
	limit := int(number(fallback(object(preset["apiInput"])["promptMaxLength"], 32000)))
	prompt = truncateUTF16(prompt, limit)
	path := "generations"
	contentType := "application/json"
	payload := Object{"prompt": prompt, "n": 1, "output_format": "png", "output_compression": 100, "quality": quality}
	if size != "" && size != "auto" {
		payload["size"] = size
	}
	var reader io.Reader = strings.NewReader(jsonText(payload))
	if len(references) > 0 {
		path = "edits"
		var form bytes.Buffer
		writer := multipart.NewWriter(&form)
		for index, entry := range references {
			if index >= int(number(preset["maxImages"])) {
				break
			}
			buffer, mime, err := backend.fetchMedia(ctx, text(entry), 50<<20)
			if err != nil {
				return nil, err
			}
			header := textproto.MIMEHeader{}
			header.Set("Content-Disposition", fmt.Sprintf(`form-data; name="image[]"; filename="reference-%d.%s"`, index, extension(mime)))
			header.Set("Content-Type", mime)
			part, err := writer.CreatePart(header)
			if err != nil {
				return nil, err
			}
			if _, err = part.Write(buffer); err != nil {
				return nil, err
			}
		}
		delete(payload, "output_compression")
		for name, value := range payload {
			if err := writer.WriteField(name, text(value)); err != nil {
				return nil, err
			}
		}
		if err := writer.Close(); err != nil {
			return nil, err
		}
		reader = &form
		contentType = writer.FormDataContentType()
	}
	target := strings.TrimSuffix(text(fields["azureBaseUrl"]), "/") + "/openai/deployments/" + text(fields["azureDeployment"]) + "/images/" + path + "?api-version=" + text(fallback(preset["azureApiVersion"], "2025-04-01-preview"))
	request, err := http.NewRequestWithContext(ctx, "POST", target, reader)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Authorization", "Bearer "+key)
	request.Header.Set("Content-Type", contentType)
	response, err := backend.client.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	encoded, err := io.ReadAll(io.LimitReader(response.Body, 150<<20))
	if err != nil {
		return nil, err
	}
	var value Object
	if err = json.Unmarshal(encoded, &value); err != nil {
		return nil, fmt.Errorf("Azure error %d: non-JSON response", response.StatusCode)
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		code := text(fallback(jsonPath(value, "error.code"), jsonPath(value, "error.type")))
		if code == "EngineOverloaded" {
			return nil, errors.New("Model is overloaded right now. Please try again.")
		}
		if code == "" {
			code = fmt.Sprintf("Azure error %d", response.StatusCode)
		}
		return nil, errors.New(code)
	}
	encodedImage := text(jsonPath(value, "data.0.b64_json"))
	if encodedImage == "" {
		return nil, errors.New("Azure returned no image data")
	}
	return base64.StdEncoding.DecodeString(encodedImage)
}

func (backend *Server) codexImage(ctx context.Context, prompt string, references []any, fields, preset Object) ([]byte, error) {
	previous, err := os.MkdirTemp("", "helios-codex-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(previous)
	output := filepath.Join(previous, "output.png")
	sizes := map[string]string{"auto": "auto", "1:1": "1024x1024", "16:9": "1536x1024", "9:16": "1024x1536", "4:3": "1536x1024", "3:4": "1024x1536"}
	ratio := text(fallback(fields["aspectRatio"], "1:1"))
	size := sizes[ratio]
	if size == "" {
		size = "auto"
	}
	prompt = truncateUTF16(prompt, int(number(fallback(object(preset["apiInput"])["promptMaxLength"], 8000))))
	prompt = regexp.MustCompile(`(?i)<<<image (\d+)>>>`).ReplaceAllString(prompt, "image $1")
	if ratio != "" && ratio != "auto" {
		prompt += " Aspect ratio: " + ratio + "."
	}
	prompt = strings.TrimSpace(prompt)
	args := []string{"generate"}
	if len(references) > 0 {
		args = []string{"edit"}
	}
	for index, entry := range references {
		if index >= 5 {
			break
		}
		buffer, mime, err := backend.fetchMedia(ctx, text(entry), 50<<20)
		if err != nil {
			return nil, err
		}
		filename := filepath.Join(previous, fmt.Sprintf("reference-%d.%s", index, extension(mime)))
		if err = os.WriteFile(filename, buffer, 0600); err != nil {
			return nil, err
		}
		args = append(args, "--image", filename)
	}
	args = append(args, "--prompt", prompt, "--size", size, "--out", output, "--force")
	command := exec.CommandContext(ctx, "codex-imagegen", args...)
	var stderr bytes.Buffer
	command.Stderr = &stderr
	if err = command.Run(); err != nil {
		message := stderr.String()
		if message == "" {
			message = fmt.Sprintf("codex-imagegen spawn failed: %v — is it installed and on PATH?", err)
		}
		if len(message) > 4000 {
			message = message[len(message)-4000:]
		}
		if index := strings.LastIndex(message, "Error:"); index >= 0 {
			message = message[index+6:]
		}
		if index := strings.Index(message, "{"); index >= 0 {
			var fields Object
			if json.Unmarshal([]byte(message[index:]), &fields) == nil {
				if detail := text(jsonPath(fields, "error.message")); detail != "" {
					return nil, errors.New(detail)
				}
			}
		}
		if index := strings.Index(message, ";"); index >= 0 {
			message = message[:index]
		}
		return nil, errors.New(strings.TrimSpace(message))
	}
	return os.ReadFile(output)
}

func (backend *Server) replicateImage(ctx context.Context, fields Object) (any, error) {
	if !truth(fields["prompt"]) {
		return nil, bad("prompt is required")
	}
	key := os.Getenv("REPLICATE_API_TOKEN")
	if key == "" {
		return nil, errors.New("REPLICATE_API_TOKEN not set")
	}
	models := map[string]string{"flux-schnell": "black-forest-labs/flux-schnell", "flux-dev": "black-forest-labs/flux-dev", "sdxl": "stability-ai/sdxl:7762fd07cf82c948538e41f63f77d685e02b063e9ab983064d4550b70c1f15e"}
	model := models[text(fields["model"])]
	if model == "" {
		model = models["flux-schnell"]
	}
	payload := Object{"input": Object{"prompt": fields["prompt"], "num_outputs": 1}}
	if parts := strings.SplitN(model, ":", 2); len(parts) == 2 {
		payload["version"] = parts[1]
	} else {
		payload["model"] = model
	}
	call := func(target string, data Object) (Object, error) {
		method := "GET"
		var reader io.Reader
		if data != nil {
			method = "POST"
			reader = strings.NewReader(jsonText(data))
		}
		request, err := http.NewRequestWithContext(ctx, method, target, reader)
		if err != nil {
			return nil, err
		}
		request.Header.Set("Authorization", "Bearer "+key)
		if data != nil {
			request.Header.Set("Content-Type", "application/json")
			request.Header.Set("Prefer", "wait=60")
		}
		response, err := backend.client.Do(request)
		if err != nil {
			return nil, err
		}
		defer response.Body.Close()
		buffer, err := io.ReadAll(io.LimitReader(response.Body, 16<<20))
		if err != nil {
			return nil, err
		}
		if response.StatusCode < 200 || response.StatusCode >= 300 {
			return nil, errors.New(string(buffer))
		}
		var value Object
		err = json.Unmarshal(buffer, &value)
		return value, err
	}
	value, err := call("https://api.replicate.com/v1/predictions", payload)
	if err != nil {
		return nil, err
	}
	id := text(value["id"])
	for attempt := 0; attempt <= 30; attempt++ {
		if value["status"] == "succeeded" {
			output := value["output"]
			if list := array(output); len(list) > 0 {
				output = list[0]
			}
			return Object{"imageUrl": output}, nil
		}
		if value["status"] == "failed" {
			return nil, errors.New(text(value["error"]))
		}
		if attempt == 30 {
			break
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(2 * time.Second):
		}
		value, err = call("https://api.replicate.com/v1/predictions/"+id, nil)
		if err != nil {
			return nil, err
		}
	}
	return nil, &HTTPError{504, "Timed out"}
}
