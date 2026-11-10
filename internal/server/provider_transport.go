package server

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"net/url"
	"regexp"
	"strings"
	"time"
	"unicode/utf16"
)

type absent struct{}

func (backend *Server) providerResponse(ctx context.Context, config Object, path, protocol, model, id string, data any) (*http.Response, error) {
	target, err := providerURL(config, path, model, id)
	if err != nil {
		return nil, err
	}
	headers, err := backend.auth(config, protocol)
	if err != nil {
		return nil, err
	}
	var payload io.Reader
	method := "GET"
	if data != nil {
		method = "POST"
		if form, ok := data.(multipartPayload); ok {
			payload = bytes.NewReader(form.Bytes)
			headers.Set("Content-Type", form.ContentType)
		} else {
			payload = strings.NewReader(jsonText(data))
			headers.Set("Content-Type", "application/json")
		}
	}
	request, err := http.NewRequestWithContext(ctx, method, target, payload)
	if err != nil {
		return nil, err
	}
	request.Header = headers
	client := *backend.client
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	return client.Do(request)
}

func (backend *Server) requestJSON(ctx context.Context, config Object, path, protocol, model, id string, data any) (any, error) {
	ctx, cancel := context.WithTimeout(ctx, time.Duration(number(config["timeoutSeconds"])*float64(time.Second)))
	defer cancel()
	response, err := backend.providerResponse(ctx, config, path, protocol, model, id, data)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	encoded, err := io.ReadAll(io.LimitReader(response.Body, 150<<20))
	if err != nil {
		return nil, err
	}
	var value any
	if err = json.Unmarshal(encoded, &value); err != nil {
		return nil, fmt.Errorf("Provider returned HTTP %d with a non-JSON response.", response.StatusCode)
	}
	fields := object(value)
	if response.StatusCode < 200 || response.StatusCode >= 300 || fields["error"] != nil {
		message := fallback(object(fields["error"])["message"], fallback(fields["error"], fallback(fields["message"], fmt.Sprintf("HTTP %d", response.StatusCode))))
		return nil, fmt.Errorf("%s: %.1000s", config["name"], text(message))
	}
	return value, nil
}

func (backend *Server) mediaDataURL(ctx context.Context, location string) (string, error) {
	buffer, contentType, err := backend.referenceMedia(ctx, location)
	if err != nil {
		return "", err
	}
	return "data:" + contentType + ";base64," + base64.StdEncoding.EncodeToString(buffer), nil
}

func (backend *Server) referenceMedia(ctx context.Context, location string) ([]byte, string, error) {
	ctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	return backend.fetchMedia(ctx, location, 50<<20)
}

func (backend *Server) referenceURL(ctx context.Context, config Object, location string) (string, error) {
	if !strings.HasPrefix(location, "data:") && !strings.HasPrefix(location, "/generated/") {
		return location, nil
	}
	inline, err := backend.mediaDataURL(ctx, location)
	if err != nil {
		return "", err
	}
	if text(config["uploadPath"]) == "" {
		return inline, nil
	}
	value, err := backend.requestJSON(ctx, config, text(config["uploadPath"]), "openai", "", "", Object{"file": inline})
	if err != nil {
		return "", err
	}
	result := text(jsonPath(value, text(config["uploadResultPath"])))
	if !strings.HasPrefix(result, "http://") && !strings.HasPrefix(result, "https://") {
		return "", errors.New("Upload response did not contain a public media URL.")
	}
	return result, nil
}

func prepareInput(config Object, kind string, input Object) (Object, error) {
	model, err := modelDefinition(config, kind, text(input["model"]))
	if err != nil {
		return nil, err
	}
	if model == nil {
		return clone(input), nil
	}
	next := clone(input)
	prompt := utf16.Encode([]rune(text(input["prompt"])))
	limit := max(0, int(number(model["promptMaxLength"])))
	if len(prompt) > limit {
		prompt = prompt[:limit]
		if len(prompt) > 0 && prompt[len(prompt)-1] >= 0xD800 && prompt[len(prompt)-1] <= 0xDBFF {
			prompt = prompt[:len(prompt)-1]
		}
	}
	next["prompt"] = string(utf16.Decode(prompt))
	choice := func(field string, values []any) error {
		disabled := len(values) == 0
		if field == "aspectRatio" {
			disabled = true
			for _, value := range values {
				disabled = disabled && value == "auto"
			}
		}
		if disabled {
			delete(next, field)
			return nil
		}
		if value, present := next[field]; present && value != nil && !contains(values, value) {
			return fmt.Errorf("模型「%s」不支持 %s=%v，支持的值：%s。", model["name"], field, value, jsonText(values))
		}
		if next[field] == nil {
			next[field] = values[0]
		}
		return nil
	}
	if err = choice("aspectRatio", array(model["ratios"])); err != nil {
		return nil, err
	}
	if len(array(next["imageUrls"])) > int(number(model["maxImages"])) {
		return nil, fmt.Errorf("模型「%s」最多支持 %v 张参考图片。", model["name"], model["maxImages"])
	}
	if kind == "image" {
		if err = choice("quality", array(model["qualityOptions"])); err != nil {
			return nil, err
		}
		delete(next, "duration")
		delete(next, "resolution")
		delete(next, "sound")
		return next, nil
	}
	delete(next, "quality")
	if durations := array(model["durations"]); len(durations) > 0 {
		if next["duration"] != nil && !contains(durations, next["duration"]) {
			return nil, fmt.Errorf("模型「%s」仅支持这些时长：%s 秒。", model["name"], jsonText(durations))
		}
		next["duration"] = fallback(next["duration"], durations[0])
	} else {
		delete(next, "duration")
	}
	if err = choice("resolution", array(model["resolutions"])); err != nil {
		return nil, err
	}
	if !truth(model["sound"]) {
		delete(next, "sound")
	}
	if len(array(next["referenceVideoUrls"])) > int(number(model["maxReferenceVideos"])) || len(array(next["referenceAudioUrls"])) > int(number(model["maxReferenceAudios"])) {
		return nil, fmt.Errorf("模型「%s」的参考视频或音频超过支持数量。", model["name"])
	}
	for _, pair := range []struct{ field, handle string }{{"startFrameUrl", "startFrame"}, {"endFrameUrl", "endFrame"}, {"videoRefUrl", "videoRef"}, {"referenceVideoUrls", "referenceVideo"}, {"referenceAudioUrls", "audioRef"}, {"imageUrls", "resource"}} {
		if !contains(array(model["handles"]), pair.handle) {
			if text(next[pair.field]) != "" && next[pair.field] != nil && (len(array(next[pair.field])) > 0 || len(object(next[pair.field])) == 0 && text(next[pair.field]) != "[]") {
				return nil, fmt.Errorf("模型「%s」未启用 %s 输入，请检查模型支持的参数。", model["name"], pair.handle)
			}
			delete(next, pair.field)
		}
	}
	return next, nil
}

func (backend *Server) canonicalInput(ctx context.Context, config Object, kind string, input Object) (Object, error) {
	model, err := modelID(config, kind, text(input["model"]))
	if err != nil {
		return nil, err
	}
	canonical := Object{"model": model, "prompt": input["prompt"]}
	for _, key := range []string{"image_urls", "aspect_ratio", "quality", "duration", "resolution", "sound", "start_frame_url", "end_frame_url", "video_ref_url", "reference_video_urls", "reference_audio_urls"} {
		canonical[key] = absent{}
	}
	for _, pair := range []struct{ field, key string }{{"imageUrls", "image_urls"}, {"referenceVideoUrls", "reference_video_urls"}, {"referenceAudioUrls", "reference_audio_urls"}} {
		values := []any{}
		for _, entry := range array(input[pair.field]) {
			value, err := backend.referenceURL(ctx, config, text(entry))
			if err != nil {
				return nil, err
			}
			values = append(values, value)
		}
		if len(values) > 0 {
			canonical[pair.key] = values
		}
	}
	for _, pair := range []struct{ field, key string }{{"startFrameUrl", "start_frame_url"}, {"endFrameUrl", "end_frame_url"}, {"videoRefUrl", "video_ref_url"}} {
		if location := text(input[pair.field]); location != "" {
			canonical[pair.key], err = backend.referenceURL(ctx, config, location)
			if err != nil {
				return nil, err
			}
		}
	}
	if value := input["aspectRatio"]; value != nil && value != "auto" {
		canonical["aspect_ratio"] = value
	}
	if kind == "image" {
		if input["quality"] != nil {
			canonical["quality"] = input["quality"]
		}
	} else {
		for _, key := range []string{"duration", "resolution", "sound"} {
			if input[key] != nil {
				canonical[key] = input[key]
			}
		}
	}
	return canonical, nil
}

func renderTemplate(template any, variables Object) (any, error) {
	if value, ok := template.(string); ok {
		match := regexp.MustCompile(`^\{\{([\w_]+)\}\}$`).FindStringSubmatch(value)
		if match != nil {
			field, present := variables[match[1]]
			if !present {
				return nil, fmt.Errorf("Unknown payload placeholder: %s", match[1])
			}
			return field, nil
		}
		return value, nil
	}
	if values, ok := template.([]any); ok {
		result := []any{}
		for _, entry := range values {
			value, err := renderTemplate(entry, variables)
			if err != nil {
				return nil, err
			}
			if _, missing := value.(absent); missing {
				value = nil
			}
			result = append(result, value)
		}
		return result, nil
	}
	if fields := object(template); len(fields) > 0 {
		result := Object{}
		for key, entry := range fields {
			value, err := renderTemplate(entry, variables)
			if err != nil {
				return nil, err
			}
			if _, missing := value.(absent); !missing {
				result[key] = value
			}
		}
		return result, nil
	}
	return template, nil
}

func requestBody(config Object, kind string, input, canonical Object) (Object, error) {
	definition, err := modelDefinition(config, kind, text(input["model"]))
	if err != nil {
		return nil, err
	}
	fields := clone(object(definition["extraBody"]))
	for key, value := range canonical {
		if _, missing := value.(absent); !missing {
			fields[key] = value
		}
	}
	for _, pair := range []struct{ field, key string }{{"aspectRatio", "aspect_ratio"}, {"quality", "quality"}, {"duration", "duration"}, {"resolution", "resolution"}, {"sound", "sound"}} {
		name := text(object(definition["parameterKeys"])[pair.field])
		if name != "" && name != pair.key && fields[pair.key] != nil {
			value := fields[pair.key]
			if pair.field == "aspectRatio" && name == "size" {
				value = object(definition["sizeMap"])[text(value)]
				if value == nil {
					return nil, errors.New("参数名映射为 size 时，请配置该比例对应的实际图片尺寸。")
				}
			}
			fields[name] = value
			delete(fields, pair.key)
		}
	}
	return fields, nil
}

func (backend *Server) saveOutput(ctx context.Context, config Object, value any, kind string) ([]any, error) {
	folder := "images"
	contentType := "image/png"
	if kind == "video" {
		folder = "videos"
		contentType = "video/mp4"
	}
	entries := array(value)
	if value != nil {
		if _, ok := value.([]any); !ok {
			entries = []any{value}
		}
	}
	urls := []any{}
	for _, entry := range entries {
		mediaCtx, cancel := context.WithTimeout(ctx, 120*time.Second)
		defer cancel()
		fields := object(entry)
		currentType := text(fallback(fields["mimeType"], contentType))
		encoded := fallback(fields["b64_json"], fields["data"])
		if data, ok := encoded.(string); ok {
			buffer, err := base64.StdEncoding.DecodeString(data)
			if err != nil {
				return nil, err
			}
			location, err := backend.uploadBuffer(buffer, currentType, folder)
			if err != nil {
				return nil, err
			}
			urls = append(urls, location)
			continue
		}
		source := text(fallback(fields["url"], fallback(fields["image_url"], fields["video_url"])))
		if location, ok := entry.(string); ok {
			source = location
		}
		if source == "" {
			continue
		}
		if strings.HasPrefix(source, "data:") {
			location, err := backend.storeMedia(mediaCtx, source, folder)
			if err != nil {
				return nil, err
			}
			urls = append(urls, location)
			continue
		}
		base, err := url.Parse(text(config["baseUrl"]) + "/")
		if err != nil {
			return nil, err
		}
		relative, err := url.Parse(source)
		if err != nil {
			return nil, err
		}
		target := base.ResolveReference(relative)
		if target.Scheme != "http" && target.Scheme != "https" {
			return nil, errors.New("Unsupported generated media URL.")
		}
		request, err := http.NewRequestWithContext(mediaCtx, "GET", target.String(), nil)
		if err != nil {
			return nil, err
		}
		client := *backend.client
		if target.Host == base.Host && target.Scheme == base.Scheme {
			protocol := "openai"
			if kind == "image" {
				protocol = text(config["imageProtocol"])
			}
			headers, err := backend.auth(config, protocol)
			if err != nil {
				return nil, err
			}
			request.Header = headers
			if len(headers) > 0 {
				client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
			}
		}
		remote, err := client.Do(request)
		if err != nil {
			return nil, err
		}
		if remote.StatusCode < 200 || remote.StatusCode >= 300 {
			remote.Body.Close()
			return nil, fmt.Errorf("Could not download generated media: HTTP %d.", remote.StatusCode)
		}
		buffer, err := io.ReadAll(io.LimitReader(remote.Body, (150<<20)+1))
		remote.Body.Close()
		if err != nil {
			return nil, err
		}
		if len(buffer) > 150<<20 {
			return nil, errors.New("Generated media exceeds 150 MB.")
		}
		if mime := strings.Split(remote.Header.Get("Content-Type"), ";")[0]; mime != "" {
			currentType = mime
		}
		location, err := backend.uploadBuffer(buffer, currentType, folder)
		if err != nil {
			return nil, err
		}
		urls = append(urls, location)
	}
	return urls, nil
}

func (backend *Server) taskOutput(ctx context.Context, config Object, value any, kind string) (Object, error) {
	output := jsonPath(value, text(config["taskOutputPath"]))
	if output == nil {
		output = object(value)["data"]
	}
	urls, err := backend.saveOutput(ctx, config, output, kind)
	if err != nil {
		return nil, err
	}
	if len(urls) > 0 {
		return Object{"urls": urls}, nil
	}
	id := jsonPath(value, text(config["taskIdPath"]))
	if id == nil {
		return nil, errors.New("Provider returned neither media nor a task ID. Check the configured response paths.")
	}
	return Object{"task": Object{"id": text(id), "config": config}}, nil
}

type multipartPayload struct {
	Bytes       []byte
	ContentType string
}

func (backend *Server) providerGeneration(ctx context.Context, config Object, kind string, input Object) (Object, error) {
	config, err := effectiveConfig(config, kind, text(input["model"]))
	if err != nil {
		return nil, err
	}
	input, err = prepareInput(config, kind, input)
	if err != nil {
		return nil, err
	}
	model, err := modelID(config, kind, text(input["model"]))
	if err != nil {
		return nil, err
	}
	definition, err := modelDefinition(config, kind, text(input["model"]))
	if err != nil {
		return nil, err
	}
	extra := object(definition["extraBody"])
	keys := object(definition["parameterKeys"])
	if kind == "video" || config["imageProtocol"] == "task" {
		canonical, err := backend.canonicalInput(ctx, config, kind, input)
		if err != nil {
			return nil, err
		}
		templateKey := "imageBody"
		path := text(config["imagesPath"])
		if kind == "video" {
			templateKey = "videoBody"
			path = text(config["videoPath"])
		}
		var payload Object
		if config[templateKey] != nil {
			rendered, err := renderTemplate(config[templateKey], canonical)
			if err != nil {
				return nil, err
			}
			payload = clone(extra)
			for key, value := range object(rendered) {
				payload[key] = value
			}
		} else {
			payload, err = requestBody(config, kind, input, canonical)
			if err != nil {
				return nil, err
			}
		}
		value, err := backend.requestJSON(ctx, config, path, "openai", model, "", payload)
		if err != nil {
			return nil, err
		}
		return backend.taskOutput(ctx, config, value, kind)
	}
	if config["imageProtocol"] == "gemini" {
		parts := []any{Object{"text": input["prompt"]}}
		for _, entry := range array(input["imageUrls"]) {
			buffer, mime, err := backend.referenceMedia(ctx, text(entry))
			if err != nil {
				return nil, err
			}
			parts = append(parts, Object{"inlineData": Object{"mimeType": mime, "data": base64.StdEncoding.EncodeToString(buffer)}})
		}
		imageConfig := Object{}
		if input["aspectRatio"] != nil && input["aspectRatio"] != "auto" {
			imageConfig[text(fallback(keys["aspectRatio"], "aspectRatio"))] = input["aspectRatio"]
		}
		if quality := text(input["quality"]); quality != "" {
			key := text(fallback(keys["quality"], "imageSize"))
			if key == "imageSize" {
				if !regexp.MustCompile(`(?i)^[124]k$`).MatchString(quality) {
					return nil, errors.New("Gemini 的 imageSize 应为 1k、2k 或 4k；请检查该模型实际支持的尺寸。")
				}
				quality = strings.ToUpper(quality)
			}
			imageConfig[key] = quality
		}
		generationConfig := Object{"responseModalities": []any{"TEXT", "IMAGE"}}
		for key, value := range object(extra["generationConfig"]) {
			generationConfig[key] = value
		}
		if len(imageConfig) > 0 {
			generationConfig["imageConfig"] = imageConfig
		}
		payload := clone(extra)
		payload["contents"] = []any{Object{"role": "user", "parts": parts}}
		payload["generationConfig"] = generationConfig
		value, err := backend.requestJSON(ctx, config, text(config["imagesPath"]), "gemini", strings.TrimPrefix(model, "models/"), "", payload)
		if err != nil {
			return nil, err
		}
		images := []any{}
		for _, candidate := range array(object(value)["candidates"]) {
			for _, part := range array(object(object(candidate)["content"])["parts"]) {
				fields := object(part)
				if inline := fallback(fields["inlineData"], fields["inline_data"]); inline != nil {
					images = append(images, inline)
				}
			}
		}
		urls, err := backend.saveOutput(ctx, config, images, "image")
		if err != nil {
			return nil, err
		}
		if len(urls) == 0 {
			return nil, errors.New("Gemini returned no image. Check the model's image-generation capability and safety response.")
		}
		return Object{"urls": urls}, nil
	}
	sizeKey := text(fallback(keys["aspectRatio"], "size"))
	ratio := text(input["aspectRatio"])
	size := ""
	if definition == nil {
		sizes := map[string]string{"1:1": "1024x1024", "16:9": "1536x1024", "3:2": "1536x1024", "9:16": "1024x1536", "2:3": "1024x1536"}
		if ratio == "" {
			ratio = "1:1"
		}
		size = sizes[ratio]
	} else if sizeKey != "size" {
		size = ratio
	} else if ratio != "" && ratio != "auto" {
		size = text(object(definition["sizeMap"])[ratio])
		if size == "" {
			return nil, fmt.Errorf("请为模型「%s」配置 %s 对应的实际图片尺寸，不能自动推断上游支持的 size。", definition["name"], ratio)
		}
	}
	quality := text(input["quality"])
	if definition == nil && !contains([]any{"auto", "low", "medium", "high"}, quality) {
		quality = "auto"
	}
	fields := clone(extra)
	fields["model"] = model
	fields["prompt"] = input["prompt"]
	if size != "" && size != "auto" {
		fields[sizeKey] = size
	}
	if quality != "" {
		fields[text(fallback(keys["quality"], "quality"))] = quality
	}
	var payload any = fields
	path := text(config["imagesPath"])
	if references := array(input["imageUrls"]); len(references) > 0 {
		var buffer bytes.Buffer
		writer := multipart.NewWriter(&buffer)
		for key, value := range fields {
			encoded, ok := value.(string)
			if !ok {
				encoded = jsonText(value)
			}
			if err = writer.WriteField(key, encoded); err != nil {
				return nil, err
			}
		}
		for index, entry := range references {
			picture, mime, err := backend.referenceMedia(ctx, text(entry))
			if err != nil {
				return nil, err
			}
			ext := strings.TrimPrefix(mime, "image/")
			if ext == "" {
				ext = "png"
			}
			header := textproto.MIMEHeader{}
			header.Set("Content-Disposition", fmt.Sprintf(`form-data; name="image[]"; filename="reference-%d.%s"`, index, ext))
			header.Set("Content-Type", mime)
			part, err := writer.CreatePart(header)
			if err != nil {
				return nil, err
			}
			if _, err = part.Write(picture); err != nil {
				return nil, err
			}
		}
		if err = writer.Close(); err != nil {
			return nil, err
		}
		payload = multipartPayload{buffer.Bytes(), writer.FormDataContentType()}
		path = text(config["editsPath"])
	}
	value, err := backend.requestJSON(ctx, config, path, "openai", model, "", payload)
	if err != nil {
		return nil, err
	}
	urls, err := backend.saveOutput(ctx, config, object(value)["data"], "image")
	if err != nil {
		return nil, err
	}
	if len(urls) == 0 {
		return nil, errors.New("Provider returned no images in data[]. Check the image API protocol.")
	}
	return Object{"urls": urls}, nil
}
