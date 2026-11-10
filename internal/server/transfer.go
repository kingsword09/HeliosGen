package server

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

var portablePreferences = map[string]bool{
	"aiui-model-providers": true, "aiui-azure-endpoints": true,
	"aiui-azure-base-url": true, "aiui-azure-text-deployment": true,
	"aiui-azure-text-model": true, "heliosgen-theme": true,
}

func validateBackup(value Object) (Object, error) {
	if value["format"] != "heliosgen-config" || number(value["version"]) != 1 {
		return nil, bad("不支持的配置文件格式或版本")
	}
	registry := object(value["registry"])
	entries, valid := registry["providers"].([]any)
	if !valid || len(entries) > 200 {
		return nil, bad("服务商列表无效（最多 200 个）")
	}
	providers, seen := []any{}, map[string]bool{}
	for _, entry := range entries {
		provider := object(entry)
		original := object(provider["config"])
		id := text(original["id"])
		if !identifierPattern.MatchString(id) || seen[id] {
			return nil, bad("服务商 ID 缺失或重复")
		}
		seen[id] = true
		models, valid := original["models"].([]any)
		if !valid || len(models) > 1000 {
			return nil, bad("模型列表无效（每个服务商最多 1000 个）")
		}
		modelIDs := map[string]bool{}
		for _, entry := range models {
			model := object(entry)
			modelID := text(model["id"])
			if !identifierPattern.MatchString(modelID) || modelIDs[modelID] {
				return nil, bad("模型 ID 缺失或重复")
			}
			modelIDs[modelID] = true
		}
		config, err := normalizeProvider(original)
		if err != nil {
			return nil, err
		}
		result := Object{"config": config}
		if key, exists := provider["apiKey"]; exists {
			if _, valid := key.(string); !valid || len(text(key)) > 16384 {
				return nil, bad("API Key 格式无效")
			}
			result["apiKey"] = key
		}
		providers = append(providers, result)
	}
	active := text(registry["activeId"])
	if active != "" && !seen[active] {
		return nil, bad("默认服务商不存在")
	}
	defaults := object(registry["defaultProviderIds"])
	for kind, id := range defaults {
		if (kind != "image" && kind != "video" && kind != "text") || !seen[text(id)] {
			return nil, bad("默认模型服务商无效")
		}
	}
	preferences := object(value["preferences"])
	for key, entry := range preferences {
		if !portablePreferences[key] {
			return nil, bad("配置包含不可迁移的本机设置")
		}
		if _, valid := entry.(string); !valid || len(text(entry)) > 100000 {
			return nil, bad("界面设置无效")
		}
		if key == "heliosgen-theme" && entry != "dark" && entry != "light" {
			return nil, bad("主题设置无效")
		}
		if key == "aiui-model-providers" || key == "aiui-azure-endpoints" {
			var values map[string]string
			if json.Unmarshal([]byte(text(entry)), &values) != nil {
				return nil, bad("模型设置必须为 JSON 对象")
			}
			if key == "aiui-model-providers" {
				for _, backend := range values {
					if backend != "custom" && backend != "azure" && backend != "codex" {
						return nil, bad("模型后端无效")
					}
				}
			}
		}
	}
	result := Object{"format": "heliosgen-config", "version": 1, "registry": Object{"providers": providers, "activeId": active, "defaultProviderIds": defaults}, "preferences": preferences}
	if key, exists := value["azureApiKey"]; exists {
		if _, valid := key.(string); !valid || len(text(key)) > 16384 {
			return nil, bad("Azure Key 无效")
		}
		result["azureApiKey"] = key
	}
	return result, nil
}

func (backend *Server) transferSettings(request *http.Request) (any, error) {
	if request.Header.Get("X-Helios-UI") != "1" {
		return nil, &HTTPError{403, "仅限应用内操作"}
	}
	if request.Method == "GET" {
		return Object{"nativeSave": backend.config.ChooseConfigPath != nil}, nil
	}
	if err := method(request, "POST"); err != nil {
		return nil, err
	}
	buffer, err := io.ReadAll(io.LimitReader(request.Body, (4<<20)+1))
	if err != nil || len(buffer) > 4<<20 {
		return nil, bad("配置文件最大 4 MB")
	}
	var fields Object
	if json.Unmarshal(buffer, &fields) != nil {
		return nil, bad("配置 JSON 无效")
	}
	backend.mu.Lock()
	locked := true
	defer func() {
		if locked {
			backend.mu.Unlock()
		}
	}()
	action := text(fields["action"])
	if action == "export" {
		registry, err := backend.registry()
		if err != nil {
			return nil, err
		}
		backup := Object{"format": "heliosgen-config", "version": 1, "appVersion": backend.config.Version, "exportedAt": now(), "registry": registry, "preferences": object(fields["preferences"])}
		if !truth(fields["includeKeys"]) {
			for _, entry := range array(registry["providers"]) {
				delete(object(entry), "apiKey")
			}
		} else {
			backup["azureApiKey"] = backend.setting("azure_api_key")
		}
		if _, err = validateBackup(backup); err != nil {
			return nil, err
		}
		filename := "heliosgen-config-" + time.Now().Format("20060102-150405") + ".json"
		backend.mu.Unlock()
		locked = false
		if truth(fields["native"]) && backend.config.ChooseConfigPath != nil {
			path, err := backend.config.ChooseConfigPath(filename)
			if err != nil {
				return nil, err
			}
			if path == "" {
				return Object{"cancelled": true}, nil
			}
			encoded, err := json.MarshalIndent(backup, "", "  ")
			if err != nil {
				return nil, err
			}
			file, err := os.CreateTemp(filepath.Dir(path), ".helios-config-*")
			if err != nil {
				return nil, err
			}
			defer os.Remove(file.Name())
			if _, err = file.Write(encoded); err != nil {
				file.Close()
				return nil, err
			}
			if err = file.Sync(); err != nil {
				file.Close()
				return nil, err
			}
			if err = file.Close(); err != nil {
				return nil, err
			}
			if err = os.Rename(file.Name(), path); err != nil {
				return nil, err
			}
			return Object{"saved": true, "path": path}, nil
		}
		return Object{"backup": backup, "filename": filename}, nil
	}
	if action != "preview" && action != "import" {
		return nil, bad("不支持的操作")
	}
	backup, err := validateBackup(object(fields["backup"]))
	if err != nil {
		return nil, err
	}
	current, err := backend.registry()
	if err != nil {
		return nil, err
	}
	incoming := object(backup["registry"])
	existing := map[string]Object{}
	for _, entry := range array(current["providers"]) {
		provider := object(entry)
		existing[text(object(provider["config"])["id"])] = provider
	}
	summaries, conflicts, models, keys := []any{}, 0, 0, 0
	for _, entry := range array(incoming["providers"]) {
		provider := object(entry)
		config := object(provider["config"])
		conflict := existing[text(config["id"])] != nil
		if conflict {
			conflicts++
		}
		if text(provider["apiKey"]) != "" {
			keys++
		}
		models += len(array(config["models"]))
		summaries = append(summaries, Object{"name": config["name"], "modelCount": len(array(config["models"])), "conflict": conflict, "hasKey": text(provider["apiKey"]) != ""})
	}
	if action == "preview" {
		return Object{"providers": summaries, "models": models, "conflicts": conflicts, "keys": keys, "hasAzureKey": text(backup["azureApiKey"]) != "", "preferences": len(object(backup["preferences"]))}, nil
	}
	mode := text(fields["mode"])
	if mode != "merge" && mode != "replace" {
		return nil, bad("请选择合并或替换")
	}
	providers := []any{}
	if mode == "merge" {
		providers = append(providers, array(current["providers"])...)
	}
	for _, entry := range array(incoming["providers"]) {
		provider := object(entry)
		id := text(object(provider["config"])["id"])
		if _, present := provider["apiKey"]; !present {
			provider["apiKey"] = fallback(existing[id]["apiKey"], "")
		}
		matched := false
		for index, entry := range providers {
			if object(object(entry)["config"])["id"] == id {
				providers[index] = provider
				matched = true
			}
		}
		if !matched {
			providers = append(providers, provider)
		}
	}
	active := incoming["activeId"]
	defaults := clone(object(incoming["defaultProviderIds"]))
	if mode == "merge" {
		active = fallback(current["activeId"], active)
		for kind, id := range object(current["defaultProviderIds"]) {
			defaults[kind] = id
		}
	}
	if text(active) == "" && len(providers) > 0 {
		active = object(object(providers[0])["config"])["id"]
	}
	registry := Object{"providers": providers, "activeId": active, "defaultProviderIds": defaults}
	tx, err := backend.db.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if _, err = tx.Exec("INSERT OR REPLACE INTO settings(key,value) VALUES('custom_provider_registry',?)", jsonText(registry)); err != nil {
		return nil, err
	}
	if key, exists := backup["azureApiKey"]; exists {
		if _, err = tx.Exec("INSERT OR REPLACE INTO settings(key,value) VALUES('azure_api_key',?)", strings.TrimSpace(text(key))); err != nil {
			return nil, err
		}
	}
	if err = tx.Commit(); err != nil {
		return nil, err
	}
	return Object{"ok": true, "preferences": backup["preferences"]}, nil
}
