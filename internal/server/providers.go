package server

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strings"
	"unicode/utf16"
)

var identifierPattern = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,100}$`)
var chatPaths = map[string]string{"openai": "chat/completions", "responses": "responses", "gemini": "models/{model}:streamGenerateContent?alt=sse", "anthropic": "messages"}

func defaultProvider() Object {
	return Object{"id": "provider-default", "name": "Custom Provider", "baseUrl": "", "imageProtocol": "openai", "chatProtocol": "openai", "imageModel": "", "chatModel": "", "videoModel": "", "models": []any{}, "modelsPath": "models", "modelsProtocol": "auto", "modelsResultPath": "", "imagesPath": "images/generations", "editsPath": "images/edits", "chatPath": "chat/completions", "videoPath": "videos", "statusPath": "tasks/{id}", "uploadPath": "", "uploadResultPath": "url", "taskIdPath": "id", "taskStatePath": "status", "taskOutputPath": "output", "authHeader": "Authorization", "authPrefix": "Bearer ", "timeoutSeconds": 720, "modelMap": Object{}, "imageBody": nil, "videoBody": nil}
}

func defaultModel(kind, apiID string) Object {
	return Object{"id": "model-" + uuid(), "apiId": apiID, "name": apiID, "kind": kind, "enabled": true, "ratios": []any{"auto"}, "qualityOptions": []any{}, "maxImages": 0, "maxReferenceVideos": 0, "maxReferenceAudios": 0, "promptMaxLength": 32000, "durations": []any{}, "resolutions": []any{}, "handles": []any{"prompt"}, "sound": false, "sizeMap": Object{}, "parameterKeys": Object{}, "extraBody": Object{}, "maxOutputTokens": nil}
}

func contains(values []any, value any) bool {
	for _, entry := range values {
		if jsonText(entry) == jsonText(value) {
			return true
		}
	}
	return false
}
func protocols(kind string) []any {
	if kind == "image" {
		return []any{"openai", "gemini", "task"}
	}
	if kind == "text" {
		return []any{"openai", "responses", "gemini", "anthropic"}
	}
	return []any{"task"}
}

func validEndpoint(path string) bool {
	parsed, err := url.Parse(path)
	return err == nil && parsed.Scheme == "" && parsed.Host == "" && !strings.HasPrefix(path, "//") && !strings.ContainsAny(path, "\\\r\n")
}

func normalizeProvider(input Object) (Object, error) {
	config := defaultProvider()
	for key, value := range input {
		if _, known := config[key]; !known {
			continue
		}
		if key == "models" || key == "modelMap" || key == "imageBody" || key == "videoBody" || key == "timeoutSeconds" {
			continue
		}
		field, valid := value.(string)
		if !valid {
			return nil, bad(key + " must be a string.")
		}
		if key != "authPrefix" {
			field = strings.TrimSpace(field)
		}
		config[key] = field
	}
	if !identifierPattern.MatchString(text(config["id"])) {
		return nil, bad("Provider ID must contain only letters, numbers, underscores, or hyphens.")
	}
	if base := text(config["baseUrl"]); base != "" {
		parsed, err := url.Parse(base)
		if err != nil || parsed.Scheme != "http" && parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
			return nil, bad("Base URL must be an HTTP(S) URL without credentials, query parameters, or fragments.")
		}
		config["baseUrl"] = strings.TrimRight(base, "/")
	}
	if !contains(protocols("image"), config["imageProtocol"]) || !contains(protocols("text"), config["chatProtocol"]) {
		return nil, bad("Unsupported provider protocol.")
	}
	if _, specified := input["chatPath"]; !specified {
		config["chatPath"] = chatPaths[text(config["chatProtocol"])]
	}
	if !contains([]any{"auto", "openai", "gemini", "anthropic"}, config["modelsProtocol"]) {
		return nil, bad("Unsupported model-list protocol.")
	}
	for _, field := range []string{"modelsPath", "imagesPath", "editsPath", "chatPath", "videoPath", "statusPath", "uploadPath"} {
		if !validEndpoint(text(config[field])) {
			return nil, bad(field + " must be a relative path on the configured provider.")
		}
	}
	if strings.ContainsAny(text(config["authPrefix"]), "\r\n") || !regexp.MustCompile("^[!#$%&'*+.^_`|~\\w-]+$").MatchString(text(config["authHeader"])) {
		return nil, bad("Invalid authentication header.")
	}
	if value, present := input["timeoutSeconds"]; present {
		seconds := number(value)
		if !numeric(value) || !finite(seconds) || seconds < 5 || seconds > 1200 {
			return nil, bad("Timeout must be between 5 and 1200 seconds.")
		}
		config["timeoutSeconds"] = seconds
	}
	for _, key := range []string{"modelMap", "imageBody", "videoBody"} {
		if value, present := input[key]; present {
			if value != nil {
				if _, valid := value.(map[string]any); !valid {
					if _, valid = value.(Object); !valid {
						return nil, bad(key + " must be an object or null.")
					}
				}
			}
			config[key] = value
		}
	}
	models := []any{}
	if value, present := input["modelMap"]; present {
		if !isObject(value) {
			return nil, bad("modelMap must be an object.")
		}
		mappings := Object{}
		for alias, entry := range object(value) {
			model, valid := entry.(string)
			if !valid || strings.TrimSpace(model) == "" {
				return nil, bad("Model mappings must contain nonempty model IDs.")
			}
			mappings[alias] = strings.TrimSpace(model)
		}
		config["modelMap"] = mappings
	}
	seen := map[string]bool{}
	if value := input["models"]; value != nil {
		if _, valid := value.([]any); !valid {
			return nil, bad("Models must be an array of at most 1000 entries.")
		}
	}
	for _, entry := range array(input["models"]) {
		value := object(entry)
		kind := text(value["kind"])
		if !contains([]any{"image", "text", "video"}, kind) {
			return nil, bad("Model type must be image, text, or video.")
		}
		model, err := normalizeModel(value)
		if err != nil {
			return nil, err
		}
		for _, key := range []string{"id", "apiId", "name"} {
			field, valid := model[key].(string)
			if !valid || strings.TrimSpace(field) == "" || len(field) > 300 {
				return nil, bad("Model " + key + " is required (maximum 300 characters).")
			}
			model[key] = strings.TrimSpace(field)
		}
		id := text(model["id"])
		if seen[id] || !identifierPattern.MatchString(id) {
			return nil, bad("Model IDs must be unique and contain only letters, numbers, underscores, or hyphens.")
		}
		seen[id] = true
		connection := object(model["connection"])
		if protocol := text(connection["protocol"]); protocol != "" && !contains(protocols(kind), protocol) {
			return nil, bad("此模型类型不支持所选接口方式。")
		}
		for key, field := range connection {
			if !contains([]any{"protocol", "basePath", "generatePath", "editsPath", "statusPath", "uploadPath", "uploadResultPath", "taskIdPath", "taskStatePath", "taskOutputPath", "authMode", "authHeader", "authPrefix", "body"}, key) {
				return nil, bad("模型接口设置包含不支持的字段；API Key 请保存在供应商连接中。")
			}
			if key != "body" {
				value, valid := field.(string)
				if !valid || len(value) > 2000 {
					return nil, bad("模型接口 " + key + " 必须是有效字符串。")
				}
				if key != "authPrefix" {
					connection[key] = strings.TrimSpace(value)
				}
			}
			if key == "basePath" || key == "generatePath" || key == "editsPath" || key == "statusPath" || key == "uploadPath" {
				if !validEndpoint(text(field)) || strings.Contains(text(field), "#") {
					return nil, bad("模型接口只能使用同一供应商下的路径，不能填写其他域名。")
				}
			}
			if key == "basePath" {
				path := text(field)
				decoded, err := url.PathUnescape(path)
				if err != nil || !strings.HasPrefix(path, "/") || strings.HasPrefix(decoded, "//") || strings.ContainsAny(decoded, "?#\\") {
					return nil, bad("接口前缀无效。")
				}
				for _, part := range strings.Split(decoded, "/") {
					if part == "." || part == ".." {
						return nil, bad("接口前缀不能包含上级目录。")
					}
				}
			}
			if key != "body" && strings.ContainsAny(text(field), "\r\n") {
				return nil, bad("模型接口设置包含无效字符串。")
			}
		}
		if header, present := connection["authHeader"]; present && !regexp.MustCompile("^[!#$%&'*+.^_`|~\\w-]+$").MatchString(text(header)) {
			return nil, bad("认证请求头名称无效。")
		}
		if template, present := connection["body"]; present && template != nil && (!isObject(template) || utf16Length(jsonText(template)) > 32000) {
			return nil, bad("模型任务请求模板必须是 JSON 对象或 null（最多 32000 字符）。")
		}
		if kind == "text" {
			for _, key := range []string{"editsPath", "statusPath", "uploadPath", "uploadResultPath", "taskIdPath", "taskStatePath", "taskOutputPath", "body"} {
				if _, present := connection[key]; present {
					return nil, bad("文本模型不支持图片编辑、上传或任务轮询设置。")
				}
			}
		}
		if kind == "video" {
			if _, present := connection["editsPath"]; present {
				return nil, bad("视频模型不支持图片编辑路径。")
			}
		}
		if mode := text(connection["authMode"]); mode != "" && !contains([]any{"provider", "bearer", "gemini", "anthropic", "custom"}, mode) {
			return nil, bad("不支持的模型认证方式。")
		}
		if text(connection["authMode"]) == "custom" && text(connection["authHeader"]) == "" {
			return nil, bad("请填写自定义认证请求头名称。")
		}
		if _, present := model["parameterProtocol"]; !present {
			model["parameterProtocol"] = modelProtocol(config, model)
		}
		if !contains(protocols(kind), model["parameterProtocol"]) {
			return nil, bad("模型参数所属接口无效。")
		}
		model, err = resolveModelParameters(model, modelProtocol(config, model))
		if err != nil {
			return nil, err
		}
		models = append(models, model)
	}
	if len(models) > 1000 {
		return nil, bad("Models must be an array of at most 1000 entries.")
	}
	for _, pair := range []struct{ kind, field string }{{"image", "imageModel"}, {"text", "chatModel"}, {"video", "videoModel"}} {
		legacy := text(config[pair.field])
		available := ""
		matched := false
		for _, entry := range models {
			value := object(entry)
			if value["kind"] == pair.kind && value["apiId"] == legacy {
				matched = true
			}
		}
		if legacy != "" && !matched {
			value := defaultModel(pair.kind, legacy)
			id := "legacy-" + pair.kind
			for seen[id] {
				id += "-default"
			}
			value["id"] = id
			value["parameterProtocol"] = modelProtocol(config, value)
			value, err := resolveModelParameters(value, modelProtocol(config, value))
			if err != nil {
				return nil, err
			}
			models = append(models, value)
			seen[id] = true
		}
		for _, entry := range models {
			value := object(entry)
			if value["kind"] == pair.kind && truth(value["enabled"]) {
				if available == "" || value["apiId"] == legacy {
					available = text(value["apiId"])
				}
			}
		}
		config[pair.field] = available
	}
	config["models"] = models
	return config, nil
}

func (backend *Server) registry() (Object, error) {
	if stored := backend.setting("custom_provider_registry"); stored != "" {
		var registry Object
		if err := json.Unmarshal([]byte(stored), &registry); err != nil {
			return nil, err
		}
		for _, entry := range array(registry["providers"]) {
			provider := object(entry)
			config, err := normalizeProvider(object(provider["config"]))
			if err != nil {
				return nil, err
			}
			provider["config"] = config
		}
		return registry, nil
	}
	input := defaultProvider()
	if legacy := backend.setting("custom_provider_config"); legacy != "" {
		if err := json.Unmarshal([]byte(legacy), &input); err != nil {
			return nil, err
		}
	} else {
		for _, field := range []struct{ key, env string }{{"baseUrl", "CUSTOM_PROVIDER_BASE_URL"}, {"imageProtocol", "CUSTOM_PROVIDER_IMAGE_PROTOCOL"}, {"chatProtocol", "CUSTOM_PROVIDER_CHAT_PROTOCOL"}, {"imageModel", "CUSTOM_PROVIDER_IMAGE_MODEL"}, {"chatModel", "CUSTOM_PROVIDER_CHAT_MODEL"}, {"videoModel", "CUSTOM_PROVIDER_VIDEO_MODEL"}} {
			if value := os.Getenv(field.env); value != "" {
				input[field.key] = value
			}
		}
	}
	config, err := normalizeProvider(input)
	if err != nil {
		return nil, err
	}
	registry := Object{"activeId": nil, "providers": []any{}}
	if text(config["baseUrl"]) != "" {
		registry["activeId"] = config["id"]
		key := backend.setting("custom_provider_api_key")
		if key == "" {
			key = os.Getenv("CUSTOM_PROVIDER_API_KEY")
		}
		registry["providers"] = []any{Object{"config": config, "apiKey": key}}
	}
	if err = backend.setSetting("custom_provider_registry", jsonText(registry)); err != nil {
		return nil, err
	}
	return registry, nil
}

func defaultSavedProvider(registry Object, kind string) Object {
	available := []Object{}
	for _, entry := range array(registry["providers"]) {
		provider := object(entry)
		config := object(provider["config"])
		for _, model := range array(config["models"]) {
			definition := object(model)
			if text(config["baseUrl"]) != "" && definition["kind"] == kind && truth(definition["enabled"]) {
				available = append(available, provider)
				break
			}
		}
	}
	for _, wanted := range []any{object(registry["defaultProviderIds"])[kind], registry["activeId"]} {
		for _, provider := range available {
			if object(provider["config"])["id"] == wanted {
				return provider
			}
		}
	}
	if len(available) > 0 {
		return available[0]
	}
	return Object{}
}

func (backend *Server) providerConfig(id, kind string) (Object, error) {
	registry, err := backend.registry()
	if err != nil {
		return nil, err
	}
	if id == "" && kind != "" {
		if provider := defaultSavedProvider(registry, kind); len(provider) > 0 {
			return clone(object(provider["config"])), nil
		}
		return defaultProvider(), nil
	}
	if id == "" {
		id = text(registry["activeId"])
	}
	for _, entry := range array(registry["providers"]) {
		config := object(object(entry)["config"])
		if config["id"] == id {
			return clone(config), nil
		}
	}
	config := defaultProvider()
	if id != "" {
		config["id"] = id
	}
	return config, nil
}

func (backend *Server) publicProviders() (Object, error) {
	registry, err := backend.registry()
	if err != nil {
		return nil, err
	}
	providers := []any{}
	active := defaultProvider()
	hasKey := false
	ready := false
	for _, entry := range array(registry["providers"]) {
		provider := object(entry)
		config := object(provider["config"])
		providers = append(providers, Object{"config": config, "hasKey": text(provider["apiKey"]) != ""})
		if config["id"] == registry["activeId"] {
			active = config
			hasKey = text(provider["apiKey"]) != ""
		}
		ready = ready || text(config["baseUrl"]) != ""
	}
	defaults := Object{}
	for _, kind := range []string{"image", "video", "text"} {
		if provider := defaultSavedProvider(registry, kind); len(provider) > 0 {
			defaults[kind] = object(provider["config"])["id"]
		}
	}
	return Object{"providers": providers, "activeId": registry["activeId"], "defaultProviderIds": defaults, "config": active, "hasKey": hasKey, "ready": ready}, nil
}

func (backend *Server) providerSettings(request *http.Request) (any, error) {
	backend.mu.Lock()
	defer backend.mu.Unlock()
	if request.Method == "GET" {
		return backend.publicProviders()
	}
	registry, err := backend.registry()
	if err != nil {
		return nil, err
	}
	providers := array(registry["providers"])
	switch request.Method {
	case "POST":
		fields, err := body(request)
		if err != nil {
			return nil, err
		}
		config, err := normalizeProvider(object(fields["config"]))
		if err != nil {
			return nil, err
		}
		if text(config["baseUrl"]) == "" {
			return nil, bad("Base URL is required.")
		}
		matched := false
		for _, entry := range providers {
			provider := object(entry)
			if object(provider["config"])["id"] == config["id"] {
				provider["config"] = config
				if key, present := fields["apiKey"]; present {
					provider["apiKey"] = strings.TrimSpace(text(key))
				}
				matched = true
			}
		}
		if !matched {
			providers = append(providers, Object{"config": config, "apiKey": strings.TrimSpace(text(fields["apiKey"]))})
		}
		if text(registry["activeId"]) == "" {
			registry["activeId"] = config["id"]
		}
	case "PATCH":
		fields, err := body(request)
		if err != nil {
			return nil, err
		}
		found := false
		for _, entry := range providers {
			config := object(object(entry)["config"])
			if config["id"] == fields["activeId"] {
				found = true
				if kind := text(fields["kind"]); kind != "" {
					enabled := false
					for _, model := range array(config["models"]) {
						value := object(model)
						enabled = enabled || value["kind"] == kind && truth(value["enabled"])
					}
					if !enabled {
						return nil, bad("请先为此供应商添加并启用当前类型的模型。")
					}
					defaults := object(registry["defaultProviderIds"])
					defaults[kind] = config["id"]
					registry["defaultProviderIds"] = defaults
				} else {
					registry["activeId"] = config["id"]
				}
			}
		}
		if !found {
			return nil, bad("供应商不存在。")
		}
	case "DELETE":
		id := request.URL.Query().Get("id")
		if id == "" {
			id = text(registry["activeId"])
		}
		kept := []any{}
		for _, entry := range providers {
			if object(object(entry)["config"])["id"] != id {
				kept = append(kept, entry)
			}
		}
		providers = kept
		for kind, value := range object(registry["defaultProviderIds"]) {
			if value == id {
				delete(object(registry["defaultProviderIds"]), kind)
			}
		}
		if registry["activeId"] == id {
			registry["activeId"] = nil
			if len(providers) > 0 {
				registry["activeId"] = object(object(providers[0])["config"])["id"]
			}
		}
	default:
		return nil, &HTTPError{405, "Method not allowed"}
	}
	registry["providers"] = providers
	if err = backend.setSetting("custom_provider_registry", jsonText(registry)); err != nil {
		return nil, err
	}
	public, err := backend.publicProviders()
	if err != nil {
		return nil, err
	}
	public["ok"] = true
	return public, nil
}

func modelProtocol(config, model Object) string {
	if protocol := text(object(model["connection"])["protocol"]); protocol != "" {
		return protocol
	}
	switch model["kind"] {
	case "image":
		return text(config["imageProtocol"])
	case "text":
		return text(config["chatProtocol"])
	default:
		return "task"
	}
}

func modelID(config Object, kind, selected string) (string, error) {
	if strings.HasPrefix(selected, "provider-model:") {
		for _, entry := range array(config["models"]) {
			model := object(entry)
			if selected == "provider-model:"+text(config["id"])+":"+text(model["id"]) && truth(model["enabled"]) && model["kind"] == kind {
				return text(model["apiId"]), nil
			}
		}
		return "", errors.New("This model is unavailable for the active provider. Select a model again or enable it in Settings.")
	}
	model := text(object(config["modelMap"])[selected])
	if model == "" {
		model = selected
	}
	if selected == "custom-"+kind && text(object(config["modelMap"])[selected]) == "" {
		field := kind + "Model"
		if kind == "text" {
			field = "chatModel"
		}
		model = text(config[field])
	}
	if model == "" {
		return "", errors.New("请先在设置的模型页面添加模型。")
	}
	found := false
	enabled := false
	for _, entry := range array(config["models"]) {
		value := object(entry)
		if value["kind"] == kind && value["apiId"] == model {
			found = true
			enabled = enabled || truth(value["enabled"])
		}
	}
	if found && !enabled {
		return "", errors.New("此模型已停用，请在对应模型页面启用或选择其他模型。")
	}
	return model, nil
}

func modelDefinition(config Object, kind, selected string) (Object, error) {
	id, err := modelID(config, kind, selected)
	if err != nil {
		return nil, err
	}
	for _, entry := range array(config["models"]) {
		model := object(entry)
		matched := model["apiId"] == id
		if strings.HasPrefix(selected, "provider-model:") {
			matched = selected == "provider-model:"+text(config["id"])+":"+text(model["id"])
		}
		if matched && model["kind"] == kind && truth(model["enabled"]) {
			return model, nil
		}
	}
	if kind == "image" && config["imageProtocol"] == "openai" && contains([]any{"gpt-image-2.6-flare", "gpt-image-2.6-sunburst"}, id) {
		model := defaultModel(kind, id)
		return resolveModelParameters(model, "openai")
	}
	return nil, nil
}

func effectiveConfig(config Object, kind, selected string) (Object, error) {
	model, err := modelDefinition(config, kind, selected)
	if err != nil {
		return nil, err
	}
	next := clone(config)
	if model == nil {
		if kind == "image" && config["imageProtocol"] == "gemini" {
			next["imagesPath"] = "models/{model}:generateContent"
		}
		if kind == "text" && config["chatProtocol"] == "gemini" {
			next["chatPath"] = chatPaths["gemini"]
		}
		return next, nil
	}
	connection := object(model["connection"])
	protocol := modelProtocol(config, model)
	inherited := modelProtocol(config, Object{"kind": kind})
	changed := protocol != inherited
	hasParameters := len(object(model["parameterKeys"])) > 0 || len(object(model["extraBody"])) > 0 || number(model["maxImages"]) > 0 || len(array(model["qualityOptions"])) > 0 || len(array(model["durations"])) > 0 || len(array(model["resolutions"])) > 0 || truth(model["sound"]) || model["maxOutputTokens"] != nil
	for _, ratio := range array(model["ratios"]) {
		hasParameters = hasParameters || ratio != "auto"
	}
	for _, handle := range array(model["handles"]) {
		hasParameters = hasParameters || handle != "prompt"
	}
	if old := text(model["parameterProtocol"]); old != "" && old != protocol && hasParameters {
		return nil, fmt.Errorf("模型「%s」的参数仍属于 %s，当前接口为 %s。请在设置中重新确认模型参数后保存。", model["name"], old, protocol)
	}
	next["requestConnection"] = connection
	if changed && (inherited == "gemini" && strings.EqualFold(text(config["authHeader"]), "x-goog-api-key") || inherited == "anthropic" && strings.EqualFold(text(config["authHeader"]), "x-api-key")) {
		next["authHeader"] = "Authorization"
		next["authPrefix"] = "Bearer "
	}
	defaults := defaultProvider()
	if kind == "image" {
		next["imageProtocol"] = protocol
		path := config["imagesPath"]
		if changed {
			path = defaults["imagesPath"]
		}
		if protocol == "gemini" {
			path = "models/{model}:generateContent"
		}
		next["imagesPath"] = fallback(connection["generatePath"], path)
		edits := config["editsPath"]
		if changed {
			edits = defaults["editsPath"]
		}
		next["editsPath"] = fallback(connection["editsPath"], edits)
		if value, present := connection["body"]; present {
			next["imageBody"] = value
		} else if changed {
			next["imageBody"] = nil
		}
	} else if kind == "text" {
		next["chatProtocol"] = protocol
		path := config["chatPath"]
		if changed || protocol == "gemini" {
			path = chatPaths[protocol]
		}
		next["chatPath"] = fallback(connection["generatePath"], path)
	} else {
		next["videoPath"] = fallback(connection["generatePath"], config["videoPath"])
		if value, present := connection["body"]; present {
			next["videoBody"] = value
		}
	}
	for _, field := range []string{"statusPath", "uploadPath", "uploadResultPath", "taskIdPath", "taskStatePath", "taskOutputPath"} {
		if value, present := connection[field]; present {
			next[field] = value
		}
	}
	return next, nil
}

func (backend *Server) configured(selected, kind string) (Object, error) {
	var config Object
	var err error
	if strings.HasPrefix(selected, "provider-model:") {
		parts := strings.Split(selected, ":")
		if len(parts) != 3 || !identifierPattern.MatchString(parts[1]) || !identifierPattern.MatchString(parts[2]) {
			return nil, errors.New("模型标识无效，请重新选择模型。")
		}
		config, err = backend.providerConfig(parts[1], "")
	} else {
		config, err = backend.providerConfig("", kind)
		if err == nil && text(config["baseUrl"]) == "" {
			config, err = backend.providerConfig("", "")
		}
	}
	if err != nil {
		return nil, err
	}
	if text(config["baseUrl"]) == "" {
		return nil, errors.New("请先在设置 → 服务商页面保存 API 地址。")
	}
	return effectiveConfig(config, kind, selected)
}

func encodeComponent(value string) string {
	return strings.NewReplacer("+", "%20", "%21", "!", "%27", "'", "%28", "(", "%29", ")", "%7E", "~", "%2A", "*").Replace(url.QueryEscape(value))
}

func providerURL(config Object, path, model, id string) (string, error) {
	base, err := url.Parse(strings.TrimRight(text(config["baseUrl"]), "/") + "/")
	if err != nil {
		return "", err
	}
	if prefix, present := object(config["requestConnection"])["basePath"]; present {
		base.Path = strings.TrimRight(text(prefix), "/") + "/"
		base.RawPath = ""
	}
	path = strings.ReplaceAll(strings.ReplaceAll(path, "{model}", encodeComponent(model)), "{id}", encodeComponent(id))
	relative, err := url.Parse(strings.TrimLeft(path, "/"))
	if err != nil {
		return "", err
	}
	target := base.ResolveReference(relative)
	if target.Scheme != base.Scheme || target.Host != base.Host {
		return "", errors.New("Provider endpoints must use the configured origin.")
	}
	return target.String(), nil
}

func (backend *Server) auth(config Object, protocol string) (http.Header, error) {
	registry, err := backend.registry()
	if err != nil {
		return nil, err
	}
	key := ""
	found := false
	for _, entry := range array(registry["providers"]) {
		provider := object(entry)
		current := object(provider["config"])
		if current["id"] == config["id"] && current["baseUrl"] == config["baseUrl"] {
			found = true
			key = text(provider["apiKey"])
		}
	}
	if !found {
		return nil, errors.New("This provider was removed or its Base URL changed. Restore it before retrying.")
	}
	headers := http.Header{}
	connection := object(config["requestConnection"])
	if key != "" {
		switch text(connection["authMode"]) {
		case "bearer":
			headers.Set("Authorization", "Bearer "+key)
		case "gemini":
			headers.Set("x-goog-api-key", key)
		case "anthropic":
			headers.Set("x-api-key", key)
		case "custom":
			headers.Set(text(connection["authHeader"]), text(connection["authPrefix"])+key)
		default:
			if strings.EqualFold(text(config["authHeader"]), "Authorization") && protocol == "gemini" {
				headers.Set("x-goog-api-key", key)
			} else if strings.EqualFold(text(config["authHeader"]), "Authorization") && protocol == "anthropic" {
				headers.Set("x-api-key", key)
			} else {
				headers.Set(text(config["authHeader"]), text(config["authPrefix"])+key)
			}
		}
	}
	if protocol == "anthropic" {
		headers.Set("anthropic-version", "2023-06-01")
	}
	return headers, nil
}

func jsonPath(value any, path string) any {
	if path == "" {
		return value
	}
	for _, key := range strings.Split(path, ".") {
		if key == "__proto__" || key == "constructor" || key == "prototype" {
			return nil
		}
		if values, ok := value.([]any); ok {
			index := int(number(key))
			if fmt.Sprint(index) != key || index < 0 || index >= len(values) {
				return nil
			}
			value = values[index]
		} else {
			value = object(value)[key]
		}
	}
	return value
}

func utf16Length(value string) int { return len(utf16.Encode([]rune(value))) }
