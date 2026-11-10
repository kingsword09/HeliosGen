package bridge

import (
	"encoding/json"
	"errors"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
)

type Endpoint struct {
	URL      string `json:"url"`
	Instance string `json:"instance"`
}

type Credential struct {
	ClientID string `json:"clientId"`
	Token    string `json:"token"`
}

func DataDirectory() (string, error) {
	if directory := os.Getenv("HELIOS_DATA_DIR"); directory != "" {
		return directory, nil
	}
	var base string
	var err error
	if runtime.GOOS == "linux" {
		base = os.Getenv("XDG_DATA_HOME")
		if base == "" {
			home, failure := os.UserHomeDir()
			if failure != nil {
				return "", failure
			}
			base = filepath.Join(home, ".local", "share")
		}
	} else {
		base, err = os.UserConfigDir()
	}
	return filepath.Join(base, "cash.sdd.helios.desktop"), err
}

func Directory(data string) string    { return filepath.Join(data, "integrations") }
func EndpointPath(data string) string { return filepath.Join(Directory(data), "endpoint.json") }
func CredentialPath(data, client string) string {
	return filepath.Join(Directory(data), "clients", client+".json")
}

func WritePrivate(filename string, value any) error {
	buffer, err := json.Marshal(value)
	if err != nil {
		return err
	}
	return WriteBytes(filename, buffer)
}

func WriteBytes(filename string, buffer []byte) error {
	if err := os.MkdirAll(filepath.Dir(filename), 0700); err != nil {
		return err
	}
	file, err := os.CreateTemp(filepath.Dir(filename), ".helios-*")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	if err = file.Chmod(0600); err == nil {
		_, err = file.Write(buffer)
	}
	if err == nil {
		err = file.Sync()
	}
	closeErr := file.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	return os.Rename(file.Name(), filename)
}

func ReadPrivate(filename string, destination any) error {
	info, err := os.Lstat(filename)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || info.Size() > 64<<10 || runtime.GOOS != "windows" && info.Mode().Perm()&0077 != 0 {
		return errors.New("Integration credentials must be a private regular file")
	}
	buffer, err := os.ReadFile(filename)
	if err != nil {
		return err
	}
	return json.Unmarshal(buffer, destination)
}

func ValidateEndpoint(endpoint Endpoint) error {
	parsed, err := url.Parse(endpoint.URL)
	if err != nil || parsed.Scheme != "http" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" || parsed.Path != "" {
		return errors.New("Invalid Helios loopback endpoint")
	}
	address := net.ParseIP(parsed.Hostname())
	if address == nil || !address.IsLoopback() || parsed.Port() == "" || endpoint.Instance == "" {
		return errors.New("Helios integration requires an authenticated local application")
	}
	return nil
}
