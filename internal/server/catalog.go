package server

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strings"
	"time"
)

func outputKind(item Object) string {
	outputs := array(object(item["modalities"])["output"])
	if item["type"] == "video" || contains(outputs, "video") {
		return "video"
	}
	if item["type"] == "image" || contains(outputs, "image") {
		return "image"
	}
	if contains([]any{"language", "chat", "text"}, item["type"]) || contains(outputs, "text") {
		return "text"
	}
	return ""
}

func (backend *Server) providerModels(request *http.Request) (any, error) {
	if err := method(request, "GET"); err != nil {
		return nil, err
	}
	id := request.URL.Query().Get("id")
	if id == "" {
		return nil, bad("A saved provider ID is required.")
	}
	config, err := backend.providerConfig(id, "")
	if err != nil {
		return nil, bad(err.Error())
	}
	if text(config["baseUrl"]) == "" {
		return nil, &HTTPError{404, "Save this provider before fetching models."}
	}
	config = clone(config)
	config["timeoutSeconds"] = min(number(config["timeoutSeconds"]), 30)
	protocol := text(config["modelsProtocol"])
	if protocol == "auto" {
		protocol = text(config["chatProtocol"])
		if protocol == "gemini" || config["imageProtocol"] == "gemini" {
			protocol = "gemini"
		}
	}
	models := []any{}
	positions := map[string]int{}
	tokens := map[string]bool{}
	token := ""
	for page := 0; page < 20; page++ {
		query := url.Values{}
		if protocol == "gemini" {
			query.Set("pageSize", "100")
			if token != "" {
				query.Set("pageToken", token)
			}
		}
		if protocol == "anthropic" {
			query.Set("limit", "100")
			if token != "" {
				query.Set("after_id", token)
			}
		}
		path := text(config["modelsPath"])
		if len(query) > 0 {
			separator := "?"
			if strings.Contains(path, "?") {
				separator = "&"
			}
			path += separator + query.Encode()
		}
		value, err := backend.requestJSON(request.Context(), config, path, protocol, "", "", nil)
		if err != nil {
			return nil, bad(err.Error())
		}
		envelope := object(value)
		var list any
		if path := text(config["modelsResultPath"]); path != "" {
			list = jsonPath(value, path)
		} else if _, ok := value.([]any); ok {
			list = value
		} else {
			list = fallback(envelope["data"], envelope["models"])
		}
		entries, valid := list.([]any)
		if !valid {
			return nil, bad("Model-list response must contain data[] or models[]. Configure modelsResultPath for a custom response.")
		}
		for _, entry := range entries {
			item := object(entry)
			raw := fallback(item["id"], item["name"])
			if _, ok := entry.(string); ok {
				raw = entry
			}
			rawID, valid := raw.(string)
			if !valid || strings.TrimSpace(rawID) == "" {
				continue
			}
			modelID := rawID
			if protocol == "gemini" {
				modelID = strings.TrimPrefix(rawID, "models/")
			}
			name := text(fallback(item["displayName"], fallback(item["display_name"], item["name"])))
			if name == "" || strings.HasPrefix(name, "models/") {
				name = modelID
			}
			kind := outputKind(item)
			hint := strings.ToLower(modelID + " " + name)
			if kind == "" {
				if regexp.MustCompile(`(video|veo|kling|sora|wan[\d-]|seedance)`).MatchString(hint) {
					kind = "video"
				} else if regexp.MustCompile(`(image|imagen|flux|dall[-_]?e|banana|stable[-_ ]diffusion)`).MatchString(hint) {
					kind = "image"
				} else if regexp.MustCompile(`(chat|claude|gemini|gpt|llama|qwen|deepseek)`).MatchString(hint) && !regexp.MustCompile(`(embed|audio|tts|whisper)`).MatchString(hint) {
					kind = "text"
				}
			}
			var suggested any
			if kind != "" {
				suggested = kind
			}
			model := Object{"id": modelID, "name": name, "suggestedKind": suggested}
			if index, found := positions[modelID]; found {
				models[index] = model
			} else {
				positions[modelID] = len(models)
				models = append(models, model)
			}
			if len(models) >= 1000 {
				return Object{"models": models, "truncated": true}, nil
			}
		}
		next := ""
		if protocol == "gemini" {
			next = text(envelope["nextPageToken"])
		} else if protocol == "anthropic" && truth(envelope["has_more"]) {
			next = text(envelope["last_id"])
		}
		if next == "" {
			return Object{"models": models, "truncated": false}, nil
		}
		if tokens[next] {
			return nil, bad("The provider repeated a model-list pagination token.")
		}
		tokens[next] = true
		token = next
	}
	return Object{"models": models, "truncated": true}, nil
}

func catalogStrings(value any) []any {
	result := []any{}
	for _, entry := range array(value) {
		if field, ok := entry.(string); ok && len(field) < 100 {
			result = append(result, field)
			if len(result) == 20 {
				break
			}
		}
	}
	return result
}

func parseCatalog(value any, source string) ([]any, error) {
	models := []any{}
	add := func(entry any, provider string) {
		item := object(entry)
		id, ok := item["id"].(string)
		if !ok || strings.TrimSpace(id) == "" || len(id) > 300 || provider == "" || len(provider) > 100 || len(models) >= 10000 {
			return
		}
		kind := outputKind(item)
		if kind == "" {
			return
		}
		id = strings.TrimSpace(id)
		upstream := id
		if source == "vercel" {
			upstream = strings.TrimPrefix(id, provider+"/")
		}
		if upstream == "" {
			return
		}
		canonical := provider + "/" + upstream
		if source == "models.dev" && (provider == "vercel" || provider == "openrouter") && strings.Contains(id, "/") {
			canonical = id
		}
		if explicit, ok := item["canonical_model_id"].(string); ok && len(explicit) <= 300 && regexp.MustCompile(`^[a-zA-Z0-9_-]+/.+`).MatchString(explicit) {
			canonical = explicit
		}
		parts := strings.SplitN(canonical, "/", 2)
		name := strings.TrimSpace(text(item["name"]))
		if name == "" || len(name) > 300 {
			name = parts[1]
		}
		modalities := object(item["modalities"])
		models = append(models, Object{"id": canonical, "apiId": parts[1], "name": name, "provider": parts[0], "kind": kind, "inputs": catalogStrings(modalities["input"]), "outputs": catalogStrings(modalities["output"]), "source": source})
	}
	if source == "vercel" {
		list, ok := object(value)["data"].([]any)
		if !ok {
			return nil, errors.New("在线目录返回了无效的模型列表。")
		}
		for _, entry := range list {
			item := object(entry)
			provider := text(item["owned_by"])
			if provider == "" {
				provider = strings.Split(text(item["id"]), "/")[0]
			}
			add(entry, provider)
		}
	} else {
		for provider, data := range object(value) {
			for _, entry := range object(object(data)["models"]) {
				add(entry, provider)
			}
		}
	}
	if len(models) == 0 {
		return nil, errors.New("在线目录中没有可识别的生成模型。")
	}
	return models, nil
}

func (backend *Server) modelCatalog(request *http.Request) (any, error) {
	if err := method(request, "GET"); err != nil {
		return nil, err
	}
	backend.catalogMu.Lock()
	defer backend.catalogMu.Unlock()
	var cached Object
	_ = json.Unmarshal([]byte(backend.setting("online_model_catalog_v2")), &cached)
	updated, _ := time.Parse(time.RFC3339, text(cached["updatedAt"]))
	if len(array(cached["models"])) > 0 && request.URL.Query().Get("refresh") != "1" && time.Since(updated) < 6*time.Hour {
		return cached, nil
	}
	type result struct {
		source, name string
		models       []any
		err          error
	}
	results := make(chan result, 2)
	for _, entry := range []struct{ source, name, target string }{{"vercel", "Vercel AI Gateway", "https://ai-gateway.vercel.sh/v1/models"}, {"models.dev", "models.dev", "https://models.dev/api.json"}} {
		go func() {
			ctx, cancel := context.WithTimeout(request.Context(), 15*time.Second)
			defer cancel()
			outgoing, err := http.NewRequestWithContext(ctx, "GET", entry.target, nil)
			var models []any
			if err == nil {
				client := *backend.client
				client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
				var response *http.Response
				response, err = client.Do(outgoing)
				if err == nil {
					defer response.Body.Close()
					if response.StatusCode != 200 {
						err = errors.New("Catalog download failed")
					} else {
						var buffer []byte
						buffer, err = io.ReadAll(io.LimitReader(response.Body, (12<<20)+1))
						if len(buffer) > 12<<20 {
							err = errors.New("模型目录过大。")
						}
						var value any
						if err == nil {
							err = json.Unmarshal(buffer, &value)
						}
						if err == nil {
							models, err = parseCatalog(value, entry.source)
						}
					}
				}
			}
			results <- result{entry.source, entry.name, models, err}
		}()
	}
	bySource := map[string]result{}
	for count := 0; count < 2; count++ {
		entry := <-results
		bySource[entry.source] = entry
	}
	models := []any{}
	sources := []any{}
	seen := map[string]bool{}
	failed := map[string]bool{}
	for _, source := range []string{"vercel", "models.dev"} {
		entry := bySource[source]
		if entry.err != nil {
			failed[source] = true
			continue
		}
		sources = append(sources, entry.name)
		for _, model := range entry.models {
			id := text(object(model)["id"])
			if !seen[id] && len(models) < 10000 {
				models = append(models, model)
				seen[id] = true
			}
		}
	}
	if len(models) == 0 {
		if len(array(cached["models"])) > 0 {
			cached["stale"] = true
			cached["notice"] = "在线目录暂时不可用，正在使用上次保存的目录。"
			return cached, nil
		}
		return nil, &HTTPError{502, "无法连接在线模型目录。可继续拉取服务商模型或手动添加。"}
	}
	usedCache := false
	for _, model := range array(cached["models"]) {
		fields := object(model)
		id := text(fields["id"])
		if failed[text(fields["source"])] && !seen[id] && len(models) < 10000 {
			models = append(models, model)
			seen[id] = true
			usedCache = true
		}
	}
	sort.SliceStable(models, func(first, second int) bool {
		return strings.ToLower(text(object(models[first])["name"])) < strings.ToLower(text(object(models[second])["name"]))
	})
	notice := ""
	if len(sources) < 2 {
		notice = "部分目录暂时不可用，已使用可用的数据源。"
		if usedCache {
			notice = "部分目录暂时不可用，已保留该数据源的上次缓存。"
		}
	}
	catalog := Object{"models": models, "updatedAt": now(), "sources": sources, "stale": usedCache, "notice": notice}
	return catalog, backend.setSetting("online_model_catalog_v2", jsonText(catalog))
}
