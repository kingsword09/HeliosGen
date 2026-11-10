package server

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

func sseHeaders(response http.ResponseWriter) {
	response.Header().Set("Content-Type", "text/event-stream")
	response.Header().Set("Cache-Control", "no-cache, no-transform")
	response.Header().Set("Connection", "keep-alive")
	response.Header().Set("X-Accel-Buffering", "no")
}

func emitSSE(response http.ResponseWriter, value any) error {
	_, err := fmt.Fprintf(response, "data: %s\n\n", jsonText(value))
	if flusher, ok := response.(http.Flusher); ok {
		flusher.Flush()
	}
	return err
}

func (backend *Server) assistant(response http.ResponseWriter, request *http.Request) {
	if err := method(request, "POST"); err != nil {
		writeError(response, err)
		return
	}
	fields, err := body(request)
	if err != nil {
		writeError(response, err)
		return
	}
	messages := array(fields["messages"])
	if len(messages) == 0 {
		if strings.TrimSpace(text(fields["prompt"])) == "" {
			writeError(response, bad("messages or prompt is required"))
			return
		}
		if system := strings.TrimSpace(text(fields["systemPrompt"])); system != "" {
			messages = append(messages, Object{"role": "system", "content": system})
		}
		messages = append(messages, Object{"role": "user", "content": strings.TrimSpace(text(fields["prompt"]))})
	}
	selected := text(fallback(fields["model"], "custom-text"))
	imageContext, err := backend.loadChatImages(request.Context(), messages)
	if err != nil {
		writeError(response, err)
		return
	}
	protocol := "openai"
	var upstream *http.Response
	if selected == "azure-auto" {
		key := backend.azureToken(request)
		if key == "" {
			writeError(response, &HTTPError{401, "No Azure API key configured. Add one in Settings."})
			return
		}
		endpoint := strings.TrimRight(strings.TrimSpace(text(fields["azureEndpoint"])), "/")
		if strings.HasSuffix(strings.ToLower(endpoint), "/openai") {
			endpoint = endpoint[:len(endpoint)-7]
		}
		if endpoint == "" {
			writeError(response, bad("Azure base URL not configured. Add it in Settings → API Keys."))
			return
		}
		deployment := strings.TrimSpace(text(fields["azureDeployment"]))
		if deployment == "" {
			deployment = "auto-model"
		}
		model := strings.TrimSpace(text(fields["azureModelName"]))
		if model == "" {
			model = "model-router"
		}
		payload := Object{"model": model, "messages": convertChatMessages(messages, imageContext, "openai"), "stream": true, "max_tokens": 8192, "temperature": 0.7, "top_p": 0.95, "frequency_penalty": 0, "presence_penalty": 0}
		target := endpoint + "/openai/deployments/" + deployment + "/chat/completions?api-version=2024-04-01-preview"
		outgoing, failure := http.NewRequestWithContext(request.Context(), "POST", target, strings.NewReader(jsonText(payload)))
		if failure != nil {
			writeError(response, bad(failure.Error()))
			return
		}
		outgoing.Header.Set("api-key", key)
		outgoing.Header.Set("Content-Type", "application/json")
		upstream, err = backend.client.Do(outgoing)
	} else {
		config, failure := backend.configured(selected, "text")
		if failure != nil {
			writeError(response, &HTTPError{502, failure.Error()})
			return
		}
		definition, failure := modelDefinition(config, "text", selected)
		if failure != nil {
			writeError(response, &HTTPError{502, failure.Error()})
			return
		}
		for _, entry := range messages {
			message := object(entry)
			if _, valid := message["content"].(string); !valid {
				writeError(response, bad("Message content must be a string."))
				return
			}
			if definition != nil && utf16Length(text(message["content"])) > int(number(definition["promptMaxLength"])) {
				writeError(response, &HTTPError{502, fmt.Sprintf("This model supports at most %v characters per message.", definition["promptMaxLength"])})
				return
			}
		}
		model, failure := modelID(config, "text", selected)
		if failure != nil {
			writeError(response, &HTTPError{502, failure.Error()})
			return
		}
		protocol = text(config["chatProtocol"])
		path := text(config["chatPath"])
		payload := clone(object(definition["extraBody"]))
		payload["model"] = model
		payload["messages"] = convertChatMessages(messages, imageContext, "openai")
		payload["stream"] = true
		keys := object(definition["parameterKeys"])
		if maximum := definition["maxOutputTokens"]; truth(maximum) {
			payload[text(fallback(keys["maxOutputTokens"], "max_tokens"))] = maximum
		}
		system, nonSystem := []any{}, []any{}
		for _, entry := range convertChatMessages(messages, imageContext, "anthropic") {
			message := object(entry)
			if message["role"] == "system" {
				system = append(system, message["content"])
				continue
			}
			nonSystem = append(nonSystem, entry)
		}
		contents := convertChatMessages(messages, imageContext, "gemini")
		switch protocol {
		case "responses":
			payload = Object{"store": false}
			for key, value := range object(definition["extraBody"]) {
				payload[key] = value
			}
			payload["model"] = model
			payload["input"] = convertChatMessages(messages, imageContext, "responses")
			payload["stream"] = true
			if truth(definition["maxOutputTokens"]) {
				payload[text(fallback(keys["maxOutputTokens"], "max_output_tokens"))] = definition["maxOutputTokens"]
			}
		case "anthropic":
			if path == "chat/completions" {
				path = "messages"
			}
			payload = clone(object(definition["extraBody"]))
			parts := []string{}
			for _, entry := range system {
				parts = append(parts, text(entry))
			}
			payload["model"] = model
			payload["max_tokens"] = fallback(definition["maxOutputTokens"], 1024)
			payload["stream"] = true
			payload["system"] = strings.Join(parts, "\n")
			payload["messages"] = nonSystem
		case "gemini":
			payload = clone(object(definition["extraBody"]))
			payload["contents"] = contents
			if len(system) > 0 {
				parts := []any{}
				for _, entry := range system {
					parts = append(parts, Object{"text": entry})
				}
				payload["systemInstruction"] = Object{"parts": parts}
			}
			if truth(definition["maxOutputTokens"]) {
				generation := clone(object(payload["generationConfig"]))
				generation[text(fallback(keys["maxOutputTokens"], "maxOutputTokens"))] = definition["maxOutputTokens"]
				payload["generationConfig"] = generation
			}
			model = strings.TrimPrefix(model, "models/")
		}
		ctx, cancel := context.WithTimeout(request.Context(), time.Duration(number(config["timeoutSeconds"])*float64(time.Second)))
		defer cancel()
		upstream, err = backend.providerResponse(ctx, config, path, protocol, model, "", payload)
	}
	if err != nil {
		writeError(response, &HTTPError{502, err.Error()})
		return
	}
	defer upstream.Body.Close()
	if upstream.StatusCode < 200 || upstream.StatusCode >= 300 {
		buffer, _ := io.ReadAll(io.LimitReader(upstream.Body, 1<<20))
		message := string(buffer)
		status := 502
		if selected == "azure-auto" {
			status = upstream.StatusCode
			var fields Object
			if json.Unmarshal(buffer, &fields) == nil {
				message = text(fallback(object(fields["error"])["message"], fallback(fields["message"], message)))
			}
			message = fmt.Sprintf("Azure %d: %s", status, message)
		}
		writeError(response, &HTTPError{status, message})
		return
	}
	sseHeaders(response)
	if protocol == "anthropic" || selected == "azure-auto" {
		buffer := make([]byte, 32<<10)
		for {
			count, failure := upstream.Body.Read(buffer)
			if count > 0 {
				if _, err = response.Write(buffer[:count]); err != nil {
					return
				}
				if flusher, ok := response.(http.Flusher); ok {
					flusher.Flush()
				}
			}
			if failure != nil {
				return
			}
		}
	}
	scanner := bufio.NewScanner(upstream.Body)
	scanner.Buffer(make([]byte, 64<<10), 16<<20)
	for scanner.Scan() {
		line := scanner.Text()
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		data := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if data == "" || data == "[DONE]" {
			continue
		}
		var value Object
		if err = json.Unmarshal([]byte(data), &value); err != nil {
			_ = emitSSE(response, Object{"type": "error", "error": Object{"message": "Invalid upstream streaming response."}})
			return
		}
		delta := ""
		switch protocol {
		case "gemini":
			for _, part := range array(jsonPath(value, "candidates.0.content.parts")) {
				fields := object(part)
				if !truth(fields["thought"]) {
					delta += text(fields["text"])
				}
			}
		case "responses":
			if value["type"] == "response.output_text.delta" || value["type"] == "response.refusal.delta" {
				delta = text(value["delta"])
			}
			if contains([]any{"error", "response.failed", "response.incomplete"}, value["type"]) {
				message := fallback(jsonPath(value, "response.error.message"), fallback(jsonPath(value, "error.message"), fallback(value["message"], "Responses request failed or ended before completion.")))
				_ = emitSSE(response, Object{"type": "error", "error": Object{"message": message}})
				return
			}
		default:
			delta = text(jsonPath(value, "choices.0.delta.content"))
		}
		if value["error"] != nil {
			_ = emitSSE(response, Object{"type": "error", "error": value["error"]})
			return
		}
		if delta != "" {
			if emitSSE(response, Object{"type": "content_block_delta", "delta": Object{"type": "text_delta", "text": delta}}) != nil {
				return
			}
		}
	}
	if err = scanner.Err(); err != nil && request.Context().Err() == nil {
		_ = emitSSE(response, Object{"type": "error", "error": Object{"message": err.Error()}})
	}
}

func (backend *Server) azureToken(request *http.Request) string {
	if key := backend.setting("azure_api_key"); key != "" {
		return key
	}
	return azureEnvironmentKey()
}
