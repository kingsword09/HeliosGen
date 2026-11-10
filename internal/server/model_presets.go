package server

import "encoding/json"

var modelParameterFields = []string{"ratios", "qualityOptions", "maxImages", "maxReferenceVideos", "maxReferenceAudios", "promptMaxLength", "durations", "resolutions", "handles", "sound", "sizeMap", "parameterKeys", "extraBody", "maxOutputTokens"}

func modelParameterPresets() []any {
	var presets []any
	_ = json.Unmarshal([]byte(modelParameterPresetsJSON), &presets)
	return presets
}

func resolveModelParameters(model Object, protocol string) (Object, error) {
	defaults := defaultModel(text(model["kind"]), text(model["apiId"]))
	unconfigured := true
	for _, key := range modelParameterFields {
		if jsonText(model[key]) != jsonText(defaults[key]) {
			unconfigured = false
		}
	}
	source := text(model["parameterPreset"])
	if source == "" {
		source = "custom"
		if unconfigured {
			source = "auto"
		}
	}
	model["parameterPreset"] = source
	if source == "custom" {
		return model, nil
	}
	var matched Object
	for _, entry := range modelParameterPresets() {
		preset := object(entry)
		if preset["kind"] == model["kind"] && preset["protocol"] == protocol && ((source == "auto" && contains(array(preset["apiIds"]), model["apiId"])) || preset["id"] == source) {
			matched = preset
			break
		}
	}
	if matched == nil && source != "auto" {
		return nil, bad("所选参数预设不支持当前模型类型或接口，请重新选择。")
	}
	for _, key := range modelParameterFields {
		model[key] = defaults[key]
		if value, present := object(matched["parameters"])[key]; present {
			model[key] = value
		}
	}
	model["parameterProtocol"] = protocol
	return model, nil
}
