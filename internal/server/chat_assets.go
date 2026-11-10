package server

import (
	"context"
	"encoding/base64"
	"net/http"
	"strings"
)

type chatImage struct {
	MIME string
	Data string
}

func (backend *Server) loadChatImages(ctx context.Context, messages []any) (map[int][]chatImage, error) {
	result := map[int][]chatImage{}
	cache := map[string]chatImage{}
	count, bytes := 0, 0
	for index, entry := range messages {
		message := object(entry)
		if _, valid := message["content"].(string); !valid {
			return nil, bad("Message content must be a string.")
		}
		value, present := message["imageUrls"]
		if !present {
			continue
		}
		urls, valid := value.([]any)
		if !valid || len(urls) > 16 {
			return nil, bad("每条消息最多 16 张图片")
		}
		if len(urls) > 0 && message["role"] != "user" {
			return nil, bad("只能在用户消息中附加图片")
		}
		count += len(urls)
		if count > 32 {
			return nil, bad("对话上下文最多包含 32 张图片，请新建对话")
		}
		for _, value := range urls {
			location, valid := value.(string)
			if !valid || location == "" {
				return nil, bad("图片 URL 无效")
			}
			image, present := cache[location]
			if !present {
				if !strings.HasPrefix(location, "/generated/") && !strings.HasPrefix(location, "data:image/") {
					var known int
					if err := backend.db.QueryRow("SELECT COUNT(*) FROM shared_assets WHERE url=?", location).Scan(&known); err != nil {
						return nil, err
					}
					if known == 0 {
						return nil, bad("请先将外部图片导入素材库")
					}
				}
				buffer, _, err := backend.fetchMedia(ctx, location, 8<<20)
				if err != nil {
					return nil, bad("无法读取图片附件：" + err.Error())
				}
				bytes += len(buffer)
				if bytes > 32<<20 {
					return nil, bad("图片附件总大小不能超过 32 MB")
				}
				mime := http.DetectContentType(buffer)
				if mime != "image/png" && mime != "image/jpeg" && mime != "image/webp" && mime != "image/gif" {
					return nil, bad("Chat 仅支持 PNG、JPEG、WebP 或 GIF 图片")
				}
				image = chatImage{MIME: mime, Data: base64.StdEncoding.EncodeToString(buffer)}
				cache[location] = image
			}
			result[index] = append(result[index], image)
		}
	}
	return result, nil
}

func convertChatMessages(messages []any, images map[int][]chatImage, protocol string) []any {
	result := []any{}
	for index, entry := range messages {
		message := clone(object(entry))
		delete(message, "imageUrls")
		attachments := images[index]
		if protocol == "gemini" {
			if message["role"] == "system" {
				continue
			}
			role := "user"
			if message["role"] == "assistant" {
				role = "model"
			}
			parts := []any{Object{"text": message["content"]}}
			for _, image := range attachments {
				parts = append(parts, Object{"inlineData": Object{"mimeType": image.MIME, "data": image.Data}})
			}
			result = append(result, Object{"role": role, "parts": parts})
			continue
		}
		if len(attachments) > 0 {
			textType := "text"
			if protocol == "responses" {
				textType = "input_text"
			}
			parts := []any{Object{"type": textType, "text": message["content"]}}
			for _, image := range attachments {
				dataURL := "data:" + image.MIME + ";base64," + image.Data
				switch protocol {
				case "responses":
					parts = append(parts, Object{"type": "input_image", "image_url": dataURL})
				case "anthropic":
					parts = append(parts, Object{"type": "image", "source": Object{"type": "base64", "media_type": image.MIME, "data": image.Data}})
				default:
					parts = append(parts, Object{"type": "image_url", "image_url": Object{"url": dataURL}})
				}
			}
			message["content"] = parts
		}
		result = append(result, message)
	}
	return result
}
