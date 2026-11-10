package server

import (
	"encoding/json"
	"fmt"
	"math"
	"regexp"
	"sort"
	"strings"
)

func numeric(value any) bool {
	switch value.(type) {
	case json.Number, float64, float32, int, int32, int64:
		return true
	}
	return false
}
func isObject(value any) bool {
	switch value.(type) {
	case Object, map[string]any:
		return true
	}
	return false
}

func normalizeModel(input Object) (Object, error) {
	kind := text(input["kind"])
	model := defaultModel(kind, "")
	for _, key := range []string{"id", "apiId", "name"} {
		field, valid := input[key].(string)
		if !valid || strings.TrimSpace(field) == "" || len(field) > 300 {
			return nil, bad("Model " + key + " is required (maximum 300 characters).")
		}
		model[key] = strings.TrimSpace(field)
	}
	for _, key := range []string{"connection", "parameterProtocol", "parameterPreset"} {
		if value, present := input[key]; present {
			if key == "connection" && !isObject(value) {
				return nil, bad("模型接口设置必须是对象。")
			}
			model[key] = value
		}
	}
	if value, present := input["parameterPreset"]; present {
		valid := value == "auto" || value == "custom"
		for _, entry := range modelParameterPresets() {
			preset := object(entry)
			valid = valid || (preset["id"] == value && preset["kind"] == kind)
		}
		if !valid {
			return nil, bad("模型参数预设无效。")
		}
	}
	for _, key := range []string{"enabled", "sound"} {
		if value, present := input[key]; present {
			if _, valid := value.(bool); !valid {
				return nil, bad("Model " + key + " must be a boolean.")
			}
			model[key] = value
		}
	}
	for _, key := range []string{"ratios", "qualityOptions", "resolutions", "handles"} {
		if value, present := input[key]; present {
			entries, valid := value.([]any)
			if !valid || len(entries) > 50 {
				return nil, bad("Model " + key + " must be a list of nonempty strings.")
			}
			result := []any{}
			for _, entry := range entries {
				field, valid := entry.(string)
				if !valid || strings.TrimSpace(field) == "" || len(field) > 100 {
					return nil, bad("Model " + key + " must be a list of nonempty strings.")
				}
				field = strings.TrimSpace(field)
				if !contains(result, field) {
					result = append(result, field)
				}
			}
			model[key] = result
		}
	}
	if len(array(model["ratios"])) == 0 {
		return nil, bad("Model aspect ratios must be auto or positive ratios such as 16:9.")
	}
	for _, entry := range array(model["ratios"]) {
		if !regexp.MustCompile(`(?i)^(auto|[1-9]\d*:[1-9]\d*)$`).MatchString(text(entry)) {
			return nil, bad("Model aspect ratios must be auto or positive ratios such as 16:9.")
		}
	}
	handles := array(model["handles"])
	if !contains(handles, "prompt") {
		return nil, bad("Video handles must include prompt and use supported handle names.")
	}
	for _, entry := range handles {
		if !contains([]any{"prompt", "startFrame", "endFrame", "resource", "videoRef", "referenceVideo", "audioRef"}, entry) {
			return nil, bad("Video handles must include prompt and use supported handle names.")
		}
	}
	if contains(handles, "referenceVideo") {
		model["maxReferenceVideos"] = 1
	}
	if contains(handles, "audioRef") {
		model["maxReferenceAudios"] = 1
	}
	for _, field := range []struct {
		key              string
		minimum, maximum float64
	}{{"maxImages", 0, 50}, {"maxReferenceVideos", 0, 50}, {"maxReferenceAudios", 0, 50}, {"promptMaxLength", 1, 1000000}} {
		value := fallback(input[field.key], model[field.key])
		count := number(value)
		if !numeric(value) || !finite(count) || math.Trunc(count) != count || count < field.minimum || count > field.maximum {
			return nil, bad(fmt.Sprintf("Model %s must be an integer between %v and %v.", field.key, field.minimum, field.maximum))
		}
		model[field.key] = count
	}
	if contains(handles, "referenceVideo") && number(model["maxReferenceVideos"]) == 0 || contains(handles, "audioRef") && number(model["maxReferenceAudios"]) == 0 {
		return nil, bad("启用参考视频或音频后，需设置至少 1 个参考文件的数量上限。")
	}
	if value, present := input["durations"]; present {
		entries, valid := value.([]any)
		if !valid || len(entries) > 50 {
			return nil, bad("Video durations must be a list of seconds between 0 and 1200 (empty disables this parameter).")
		}
		result := []any{}
		for _, entry := range entries {
			duration := number(entry)
			if !numeric(entry) || !finite(duration) || duration <= 0 || duration > 1200 {
				return nil, bad("Video durations must be a list of seconds between 0 and 1200 (empty disables this parameter).")
			}
			if !contains(result, duration) {
				result = append(result, duration)
			}
		}
		sort.Slice(result, func(first, second int) bool { return number(result[first]) < number(result[second]) })
		model["durations"] = result
	}
	if value, present := input["sizeMap"]; present {
		if !isObject(value) {
			return nil, bad("Size mappings must be an object.")
		}
		sizes := object(value)
		if len(sizes) > 50 {
			return nil, bad("Size mappings must map aspect ratios to sizes such as 1024x1024.")
		}
		for ratio, entry := range sizes {
			size, valid := entry.(string)
			if !valid || !regexp.MustCompile(`^(auto|[1-9]\d*:[1-9]\d*)$`).MatchString(ratio) || !regexp.MustCompile(`^(auto|[1-9]\d*x[1-9]\d*)$`).MatchString(size) {
				return nil, bad("Size mappings must map aspect ratios to sizes such as 1024x1024.")
			}
			if ratio != "auto" {
				proportions, dimensions := strings.Split(ratio, ":"), strings.Split(size, "x")
				if len(dimensions) != 2 || number(dimensions[0])*number(proportions[1]) != number(dimensions[1])*number(proportions[0]) {
					return nil, bad(fmt.Sprintf("尺寸 %s 与比例 %s 不匹配，请填写真实比例，不要将其他尺寸当成该比例。", size, ratio))
				}
				for _, part := range append(proportions, dimensions...) {
					if number(part) > 9007199254740991 {
						return nil, bad("Size mapping dimensions are too large.")
					}
				}
			}
		}
		model["sizeMap"] = sizes
	}
	if value, present := input["parameterKeys"]; present {
		if !isObject(value) {
			return nil, bad("Parameter names must be an object.")
		}
		keys := object(value)
		names := map[string]bool{}
		for key, entry := range keys {
			name, valid := entry.(string)
			if !valid || !contains([]any{"aspectRatio", "quality", "duration", "resolution", "sound", "maxOutputTokens"}, key) || !regexp.MustCompile(`^[a-zA-Z][\w-]{0,99}$`).MatchString(name) {
				return nil, bad("Parameter names must use supported keys and simple upstream field names.")
			}
			if names[name] || contains([]any{"model", "prompt", "messages", "stream", "contents", "system", "generationConfig"}, name) {
				return nil, bad("自定义参数名不能覆盖模型、提示词等必需字段，也不能重复。")
			}
			names[name] = true
		}
		model["parameterKeys"] = keys
	}
	if value, present := input["extraBody"]; present {
		if !isObject(value) || utf16Length(jsonText(value)) > 32000 {
			return nil, bad("Extra request parameters must be a JSON object of at most 32000 characters.")
		}
		model["extraBody"] = value
	}
	if value := input["maxOutputTokens"]; value != nil {
		maximum := number(value)
		if !numeric(value) || !finite(maximum) || math.Trunc(maximum) != maximum || maximum < 1 || maximum > 1000000 {
			return nil, bad("Maximum output tokens must be an integer between 1 and 1000000.")
		}
		model["maxOutputTokens"] = maximum
	}
	return model, nil
}
