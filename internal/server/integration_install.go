package server

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"heliosgen/internal/bridge"
)

type integrationToolFiles struct {
	cliPath   string
	skillPath string
	shim      []byte
	skill     []byte
}

func (tools *integrationToolFiles) installed() bool {
	cli, cliErr := os.ReadFile(tools.cliPath)
	info, modeErr := os.Stat(tools.cliPath)
	skill, skillErr := os.ReadFile(tools.skillPath)
	return cliErr == nil && modeErr == nil && info.Mode().IsRegular() && info.Mode().Perm()&0111 != 0 && skillErr == nil && bytes.Equal(cli, tools.shim) && bytes.Equal(skill, tools.skill)
}

func (backend *Server) integrationTools(agent string) (*integrationToolFiles, error) {
	if runtime.GOOS == "windows" {
		return nil, bad("Use HeliosGen.exe cli on Windows; automatic shell installation is available on macOS/Linux")
	}
	if agent != "shared" && agent != "claude" {
		return nil, bad("Choose shared (Codex/OpenCode/Pi) or claude")
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, err
	}
	executable, err := os.Executable()
	if err != nil {
		return nil, err
	}
	executable, err = filepath.Abs(executable)
	if err != nil {
		return nil, err
	}
	cliPath := filepath.Join(home, ".local", "bin", "helios")
	shim := []byte("#!/bin/sh\nexec '" + strings.ReplaceAll(executable, "'", "'\\''") + "' cli \"$@\"\n")
	skillRoot := filepath.Join(home, ".agents", "skills", "heliosgen")
	if agent == "claude" {
		claude := os.Getenv("CLAUDE_CONFIG_DIR")
		if claude == "" {
			claude = filepath.Join(home, ".claude")
		}
		skillRoot = filepath.Join(claude, "skills", "heliosgen")
	}
	skill, err := os.ReadFile(filepath.Join(backend.config.AssetDir, "agent-skills", "heliosgen", "SKILL.md"))
	if err != nil {
		return nil, bad("Bundled Helios Skill is missing; rebuild the static frontend first")
	}
	skillPath := filepath.Join(skillRoot, "SKILL.md")
	return &integrationToolFiles{cliPath: cliPath, skillPath: skillPath, shim: shim, skill: skill}, nil
}

func (backend *Server) integrationInstalledAgents() []string {
	agents := []string{}
	for _, agent := range []string{"shared", "claude"} {
		tools, err := backend.integrationTools(agent)
		if err == nil && tools.installed() {
			agents = append(agents, agent)
		}
	}
	return agents
}

func (backend *Server) installIntegrationTools(agent string) (Object, error) {
	tools, err := backend.integrationTools(agent)
	if err != nil {
		return nil, err
	}
	result := Object{"installed": true, "cliPath": tools.cliPath, "skillPath": tools.skillPath}
	if tools.installed() {
		return result, nil
	}
	cliPath, skillPath, shim, skill := tools.cliPath, tools.skillPath, tools.shim, tools.skill
	old, readErr := os.ReadFile(cliPath)
	if readErr == nil {
		digest := sha256.Sum256(old)
		if backend.setting("integration_cli_hash") != hex.EncodeToString(digest[:]) && !bytes.Equal(old, shim) {
			return nil, &HTTPError{409, "An unrelated helios command already exists; it will not be overwritten"}
		}
	} else if !os.IsNotExist(readErr) {
		return nil, readErr
	}
	marker := filepath.Join(filepath.Dir(skillPath), ".helios-owned.json")
	if existing, failure := os.ReadFile(skillPath); failure == nil && string(existing) != string(skill) {
		var owner struct {
			App string `json:"app"`
		}
		if bridge.ReadPrivate(marker, &owner) != nil || owner.App != "cash.sdd.helios.desktop" {
			return nil, &HTTPError{409, "A foreign heliosgen Skill exists; it will not be overwritten"}
		}
	} else if failure != nil && !os.IsNotExist(failure) {
		return nil, failure
	}
	if err = bridge.WriteBytes(cliPath, shim); err != nil {
		return nil, err
	}
	if err = os.Chmod(cliPath, 0700); err != nil {
		return nil, err
	}
	digest := sha256.Sum256(shim)
	if err = backend.setSetting("integration_cli_hash", hex.EncodeToString(digest[:])); err != nil {
		return nil, err
	}
	if err = bridge.WriteBytes(skillPath, skill); err != nil {
		return nil, err
	}
	if err = bridge.WritePrivate(marker, Object{"app": "cash.sdd.helios.desktop"}); err != nil {
		return nil, err
	}
	return result, nil
}
