package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"image"
	"image/gif"
	"image/jpeg"
	"image/png"
	"io"
	"mime"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"

	"golang.org/x/image/bmp"
	"golang.org/x/image/draw"
	"golang.org/x/image/tiff"
	_ "golang.org/x/image/webp"
)

func (backend *Server) serveMedia(response http.ResponseWriter, request *http.Request) {
	relative := strings.TrimPrefix(request.URL.Path, "/generated/")
	filename := filepath.Join(backend.config.MediaDir, filepath.FromSlash(relative))
	if !within(backend.config.MediaDir, filename) || strings.ContainsRune(relative, 0) {
		http.Error(response, "Forbidden", 403)
		return
	}
	info, err := os.Stat(filename)
	if err != nil || info.IsDir() {
		http.NotFound(response, request)
		return
	}
	if response.Header().Get("Content-Disposition") == "" {
		response.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	}
	http.ServeFile(response, request, filename)
}

func extension(contentType string) string {
	for _, entry := range []struct{ match, ext string }{{"mp4", "mp4"}, {"webm", "webm"}, {"png", "png"}, {"gif", "gif"}, {"webp", "webp"}} {
		if strings.Contains(contentType, entry.match) {
			return entry.ext
		}
	}
	if strings.HasPrefix(contentType, "audio") {
		for _, entry := range []struct{ match, ext string }{{"mpeg", "mp3"}, {"wav", "wav"}, {"ogg", "ogg"}} {
			if strings.Contains(contentType, entry.match) {
				return entry.ext
			}
		}
		return "m4a"
	}
	return "jpg"
}

func stripImageMetadata(buffer []byte) ([]byte, error) {
	if len(buffer) >= 8 && bytes.Equal(buffer[:8], []byte{137, 80, 78, 71, 13, 10, 26, 10}) {
		result := append([]byte{}, buffer[:8]...)
		for offset := 8; offset < len(buffer); {
			if offset+12 > len(buffer) {
				return nil, errors.New("Invalid PNG")
			}
			size := int(binary.BigEndian.Uint32(buffer[offset:])) + 12
			if size < 12 || offset+size > len(buffer) {
				return nil, errors.New("Invalid PNG")
			}
			kind := string(buffer[offset+4 : offset+8])
			if kind != "eXIf" && kind != "tEXt" && kind != "iTXt" && kind != "zTXt" && kind != "tIME" {
				result = append(result, buffer[offset:offset+size]...)
			}
			offset += size
		}
		return result, nil
	}
	if len(buffer) >= 2 && buffer[0] == 255 && buffer[1] == 216 {
		result := append([]byte{}, buffer[:2]...)
		for offset := 2; offset < len(buffer); {
			if buffer[offset] != 255 {
				return nil, errors.New("Invalid JPEG")
			}
			markerStart := offset
			for offset < len(buffer) && buffer[offset] == 255 {
				offset++
			}
			if offset >= len(buffer) {
				return nil, errors.New("Invalid JPEG")
			}
			marker := buffer[offset]
			offset++
			if marker == 218 || marker == 217 {
				result = append(result, buffer[markerStart:]...)
				return result, nil
			}
			if marker == 1 || marker >= 208 && marker <= 215 {
				result = append(result, buffer[markerStart:offset]...)
				continue
			}
			if offset+2 > len(buffer) {
				return nil, errors.New("Invalid JPEG")
			}
			size := int(binary.BigEndian.Uint16(buffer[offset:]))
			if size < 2 || offset+size > len(buffer) {
				return nil, errors.New("Invalid JPEG")
			}
			if marker != 225 && marker != 237 && marker != 254 {
				result = append(result, buffer[markerStart:offset+size]...)
			}
			offset += size
		}
		return result, nil
	}
	if len(buffer) >= 12 && string(buffer[:4]) == "RIFF" && string(buffer[8:12]) == "WEBP" {
		result := append([]byte{}, buffer[:12]...)
		for offset := 12; offset < len(buffer); {
			if offset+8 > len(buffer) {
				return nil, errors.New("Invalid WebP")
			}
			size := int(binary.LittleEndian.Uint32(buffer[offset+4:]))
			end := offset + 8 + size + (size & 1)
			if end > len(buffer) {
				return nil, errors.New("Invalid WebP")
			}
			kind := string(buffer[offset : offset+4])
			if kind != "EXIF" && kind != "XMP " {
				chunk := append([]byte{}, buffer[offset:end]...)
				if kind == "VP8X" && len(chunk) > 8 {
					chunk[8] &= ^byte(12)
				}
				result = append(result, chunk...)
			}
			offset = end
		}
		binary.LittleEndian.PutUint32(result[4:8], uint32(len(result)-8))
		return result, nil
	}
	return buffer, nil
}

func (backend *Server) stripMetadata(buffer []byte, contentType string) ([]byte, error) {
	if strings.HasPrefix(contentType, "image/") {
		if bytes.HasPrefix(buffer, []byte{255, 216}) || bytes.HasPrefix(buffer, []byte{137, 80, 78, 71}) || bytes.HasPrefix(buffer, []byte("RIFF")) {
			return stripImageMetadata(buffer)
		}
		picture, format, err := image.Decode(bytes.NewReader(buffer))
		if err == nil {
			var output bytes.Buffer
			switch format {
			case "gif":
				err = gif.Encode(&output, picture, nil)
			case "tiff":
				err = tiff.Encode(&output, picture, nil)
			case "bmp":
				err = bmp.Encode(&output, picture)
			default:
				err = png.Encode(&output, picture)
			}
			return output.Bytes(), err
		}
		return backend.convertImage(buffer, contentType)
	}
	if !strings.HasPrefix(contentType, "video/") {
		return buffer, nil
	}
	temporary, err := os.MkdirTemp("", "helios-strip-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(temporary)
	input := filepath.Join(temporary, "input."+extension(contentType))
	output := filepath.Join(temporary, "output."+extension(contentType))
	if err = os.WriteFile(input, buffer, 0600); err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(backend.ctx, 2*time.Minute)
	defer cancel()
	if diagnostic, err := exec.CommandContext(ctx, "ffmpeg", "-i", input, "-map_metadata", "-1", "-c", "copy", "-y", output).CombinedOutput(); err != nil {
		return nil, fmt.Errorf("ffmpeg: %s: %w", diagnostic, err)
	}
	return os.ReadFile(output)
}

func (backend *Server) convertImage(buffer []byte, contentType string) ([]byte, error) {
	directory, err := os.MkdirTemp("", "helios-image-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(directory)
	extension := strings.TrimPrefix(strings.Split(contentType, ";")[0], "image/")
	if extension == "svg+xml" {
		extension = "svg"
	}
	if !regexp.MustCompile(`^[a-zA-Z0-9]+$`).MatchString(extension) {
		extension = "img"
	}
	input := filepath.Join(directory, "input."+extension)
	output := filepath.Join(directory, "output.png")
	if err = os.WriteFile(input, buffer, 0600); err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(backend.ctx, time.Minute)
	defer cancel()
	var diagnostic []byte
	if runtime.GOOS == "darwin" {
		diagnostic, err = exec.CommandContext(ctx, "/usr/bin/sips", "-s", "format", "png", input, "--out", output).CombinedOutput()
	}
	if runtime.GOOS != "darwin" || err != nil {
		diagnostic, err = exec.CommandContext(ctx, "ffmpeg", "-i", input, "-frames:v", "1", "-map_metadata", "-1", "-y", output).CombinedOutput()
	}
	if err != nil {
		return nil, fmt.Errorf("Cannot decode %s image (system image converter or ffmpeg required): %s: %w", contentType, diagnostic, err)
	}
	converted, err := os.ReadFile(output)
	if err != nil {
		return nil, err
	}
	return stripImageMetadata(converted)
}

func (backend *Server) uploadBuffer(buffer []byte, contentType, folder string) (string, error) {
	buffer, err := backend.stripMetadata(buffer, contentType)
	if err != nil {
		return "", err
	}
	if strings.HasPrefix(contentType, "image/") && bytes.HasPrefix(buffer, []byte{137, 80, 78, 71}) {
		contentType = "image/png"
	}
	hash := sha256.Sum256(buffer)
	hashText := hex.EncodeToString(hash[:])
	var existing string
	if backend.db.QueryRow("SELECT cdn_url FROM asset_cache WHERE hash=?", hashText).Scan(&existing) == nil {
		return existing, nil
	}
	directory := filepath.Join(backend.config.MediaDir, filepath.FromSlash(folder))
	if !within(backend.config.MediaDir, directory) {
		return "", bad("Invalid storage folder")
	}
	if err = os.MkdirAll(directory, 0700); err != nil {
		return "", err
	}
	filename := uuid() + "." + extension(contentType)
	if err = os.WriteFile(filepath.Join(directory, filename), buffer, 0600); err != nil {
		return "", err
	}
	location := "/generated/" + strings.Trim(folder, "/") + "/" + filename
	_, err = backend.db.Exec("INSERT INTO asset_cache (hash,cdn_url,mime_type,byte_size) VALUES (?,?,?,?) ON CONFLICT(hash) DO UPDATE SET cdn_url=excluded.cdn_url,mime_type=excluded.mime_type,byte_size=excluded.byte_size", hashText, location, contentType, len(buffer))
	return location, err
}

func (backend *Server) fetchMedia(ctx context.Context, location string, limit int64) ([]byte, string, error) {
	if strings.HasPrefix(location, "data:") {
		header, encoded, valid := strings.Cut(location, ",")
		if !valid || !strings.HasSuffix(header, ";base64") {
			return nil, "", bad("Not a valid data URL")
		}
		buffer, err := base64.StdEncoding.DecodeString(strings.Join(strings.Fields(encoded), ""))
		if err != nil {
			return nil, "", err
		}
		if int64(len(buffer)) > limit {
			return nil, "", &HTTPError{413, "File exceeds size limit"}
		}
		return buffer, strings.TrimSuffix(strings.TrimPrefix(header, "data:"), ";base64"), nil
	}
	if strings.HasPrefix(location, "/generated/") {
		parsed, err := url.Parse(location)
		if err != nil {
			return nil, "", bad("Invalid media path")
		}
		filename := filepath.Join(backend.config.MediaDir, filepath.FromSlash(strings.TrimPrefix(parsed.Path, "/generated/")))
		if !within(backend.config.MediaDir, filename) {
			return nil, "", bad("Invalid media path")
		}
		buffer, err := os.ReadFile(filename)
		if err != nil {
			return nil, "", err
		}
		if int64(len(buffer)) > limit {
			return nil, "", &HTTPError{413, "File exceeds size limit"}
		}
		return buffer, mime.TypeByExtension(filepath.Ext(filename)), nil
	}
	parsed, err := url.Parse(location)
	if err != nil || parsed.Scheme != "http" && parsed.Scheme != "https" {
		return nil, "", bad("Only http/https URLs are supported")
	}
	request, err := http.NewRequestWithContext(ctx, "GET", location, nil)
	if err != nil {
		return nil, "", err
	}
	request.Header.Set("User-Agent", "Mozilla/5.0 (compatible; HeliosGen/1.0)")
	response, err := backend.client.Do(request)
	if err != nil {
		return nil, "", err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, "", bad(fmt.Sprintf("Failed to fetch URL: %s", response.Status))
	}
	buffer, err := io.ReadAll(io.LimitReader(response.Body, limit+1))
	if err != nil {
		return nil, "", err
	}
	if int64(len(buffer)) > limit {
		return nil, "", &HTTPError{413, "File exceeds size limit"}
	}
	contentType := strings.TrimSpace(strings.Split(response.Header.Get("Content-Type"), ";")[0])
	if contentType == "" {
		contentType = "image/jpeg"
	}
	return buffer, contentType, nil
}

func (backend *Server) storeMedia(ctx context.Context, location, folder string) (string, error) {
	if strings.HasPrefix(location, "/generated/") {
		return location, nil
	}
	buffer, contentType, err := backend.fetchMedia(ctx, location, 150<<20)
	if err != nil {
		return "", err
	}
	return backend.uploadBuffer(buffer, contentType, folder)
}

func (backend *Server) upload(request *http.Request) (any, error) {
	if err := method(request, "POST"); err != nil {
		return nil, err
	}
	var buffer []byte
	var contentType, folder string
	var recordedType any
	var err error
	if request.URL.Path == "/api/upload" || request.URL.Path == "/api/fetch-url" {
		fields, failure := body(request)
		if failure != nil {
			return nil, failure
		}
		location := text(fields["dataUrl"])
		folder = text(fallback(fields["folder"], "uploads"))
		limit := int64(150 << 20)
		if request.URL.Path == "/api/fetch-url" {
			location = text(fields["url"])
			limit = 50 << 20
		}
		if location == "" {
			return nil, bad("Missing url or dataUrl")
		}
		buffer, contentType, err = backend.fetchMedia(request.Context(), location, limit)
		if err != nil {
			return nil, err
		}
		recordedType = fields["mimeType"]
		if request.URL.Path == "/api/fetch-url" {
			recordedType = contentType
			if !strings.HasPrefix(contentType, "image/") && !strings.HasPrefix(contentType, "video/") {
				return nil, bad("URL does not point to an image or video")
			}
			folder = "uploads"
			if strings.HasPrefix(contentType, "video/") {
				folder = "references"
			}
		}
	} else {
		contentType = request.Header.Get("Content-Type")
		if contentType == "" {
			contentType = "application/octet-stream"
			if request.URL.Path == "/api/upload-video" {
				contentType = "video/mp4"
			}
		}
		if request.URL.Path == "/api/upload-video" && !strings.HasPrefix(contentType, "video/") {
			return nil, bad("Only video files are accepted")
		}
		recordedType = contentType
		buffer, err = io.ReadAll(io.LimitReader(request.Body, (100<<20)+1))
		if err != nil {
			return nil, err
		}
		if len(buffer) > 100<<20 {
			return nil, &HTTPError{413, "File exceeds 100 MB limit"}
		}
		folder = "uploads"
		if strings.HasPrefix(contentType, "video/") {
			folder = "references"
		}
	}
	location, err := backend.uploadBuffer(buffer, contentType, folder)
	if err != nil {
		return nil, err
	}
	_, err = backend.db.Exec("INSERT INTO uploads (id,user_id,r2_url,mime_type,source,created_at) VALUES (?,?,?,?,?,?)", uuid(), "guest", location, recordedType, "user_upload", now())
	result := Object{"cdnUrl": location}
	if request.URL.Path == "/api/fetch-url" {
		result["mediaType"] = "image"
		if strings.HasPrefix(contentType, "video/") {
			result["mediaType"] = "video"
		}
	}
	return result, err
}

func (backend *Server) download(response http.ResponseWriter, request *http.Request) {
	if err := method(request, "GET"); err != nil {
		writeError(response, err)
		return
	}
	location := request.URL.Query().Get("url")
	if location == "" {
		http.Error(response, "Missing url", 400)
		return
	}
	filename := request.URL.Query().Get("filename")
	if filename == "" {
		filename = "download"
	}
	filename = filepath.Base(strings.ReplaceAll(strings.ReplaceAll(filename, "\r", ""), "\n", ""))
	response.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": filename}))
	response.Header().Set("Cache-Control", "no-store")
	if strings.HasPrefix(location, "/generated/") {
		cloned := request.Clone(request.Context())
		parsed, _ := url.Parse(location)
		cloned.URL = parsed
		backend.serveMedia(response, cloned)
		response.Header().Set("Cache-Control", "no-store")
		return
	}
	parsed, err := url.Parse(location)
	if err != nil || parsed.Scheme != "http" && parsed.Scheme != "https" {
		http.Error(response, "Invalid URL", 400)
		return
	}
	if parsed.Scheme != "https" || parsed.Hostname() != "replicate.delivery" && parsed.Hostname() != "pbxt.replicate.delivery" {
		http.Error(response, "Forbidden", 403)
		return
	}
	upstream, err := http.NewRequestWithContext(request.Context(), "GET", location, nil)
	if err != nil {
		http.Error(response, "Invalid URL", 400)
		return
	}
	remote, err := backend.client.Do(upstream)
	if err != nil {
		http.Error(response, "Fetch failed", 502)
		return
	}
	defer remote.Body.Close()
	response.Header().Set("Content-Type", remote.Header.Get("Content-Type"))
	response.WriteHeader(remote.StatusCode)
	_, _ = io.Copy(response, remote.Body)
}

func (backend *Server) thumbnail(response http.ResponseWriter, request *http.Request) {
	if err := method(request, "GET"); err != nil {
		writeError(response, err)
		return
	}
	location := request.URL.Query().Get("url")
	if strings.HasPrefix(location, "/") && !strings.HasPrefix(location, "/generated/") {
		parsed, err := url.Parse(location)
		if err != nil {
			writeError(response, bad("Invalid asset path"))
			return
		}
		filename := filepath.Join(backend.config.AssetDir, filepath.FromSlash(strings.TrimLeft(parsed.Path, "/")))
		if !within(backend.config.AssetDir, filename) {
			writeError(response, bad("Invalid asset path"))
			return
		}
		cloned := request.Clone(request.Context())
		cloned.URL = parsed
		http.ServeFile(response, cloned, filename)
		return
	}
	buffer, contentType, err := backend.fetchMedia(request.Context(), location, 50<<20)
	if err != nil {
		writeError(response, err)
		return
	}
	picture, _, err := image.Decode(bytes.NewReader(buffer))
	if err != nil || contentType == "image/gif" {
		response.Header().Set("Content-Type", contentType)
		_, _ = response.Write(buffer)
		return
	}
	width := min(4096, max(1, int(number(request.URL.Query().Get("w")))))
	if request.URL.Query().Get("w") == "" {
		width = 640
	}
	bounds := picture.Bounds()
	width = min(width, bounds.Dx())
	height := max(1, bounds.Dy()*width/bounds.Dx())
	resized := image.NewRGBA(image.Rect(0, 0, width, height))
	draw.CatmullRom.Scale(resized, resized.Bounds(), picture, bounds, draw.Over, nil)
	quality := min(100, max(1, int(number(request.URL.Query().Get("q")))))
	if request.URL.Query().Get("q") == "" {
		quality = 75
	}
	response.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	if contentType != "image/jpeg" {
		response.Header().Set("Content-Type", "image/png")
		_ = png.Encode(response, resized)
		return
	}
	response.Header().Set("Content-Type", "image/jpeg")
	_ = jpeg.Encode(response, resized, &jpeg.Options{Quality: quality})
}
