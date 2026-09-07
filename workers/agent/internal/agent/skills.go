package agent

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/cloudwego/eino/adk"
	"github.com/cloudwego/eino/adk/filesystem"
	"github.com/cloudwego/eino/adk/middlewares/skill"
)

type osBackend struct{ root string }

func (o osBackend) LsInfo(context.Context, *filesystem.LsInfoRequest) ([]filesystem.FileInfo, error) {
	return nil, nil
}
func (o osBackend) Read(_ context.Context, req *filesystem.ReadRequest) (*filesystem.FileContent, error) {
	path := filepath.Clean(req.FilePath)
	if strings.Contains(path, "..") {
		return nil, fmt.Errorf("path_escape")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	if len(data) > 32*1024 {
		return nil, fmt.Errorf("skill_too_large")
	}
	return &filesystem.FileContent{Content: string(data)}, nil
}
func (o osBackend) GrepRaw(context.Context, *filesystem.GrepRequest) ([]filesystem.GrepMatch, error) {
	return nil, nil
}
func (o osBackend) GlobInfo(_ context.Context, req *filesystem.GlobInfoRequest) ([]filesystem.FileInfo, error) {
	root := req.Path
	entries, err := os.ReadDir(root)
	if err != nil {
		return nil, err
	}
	var out []filesystem.FileInfo
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		info, err := e.Info()
		if err == nil && info.Mode()&os.ModeSymlink != 0 {
			return nil, fmt.Errorf("symlink_rejected")
		}
		skillPath := filepath.Join(root, e.Name(), "SKILL.md")
		if _, err := os.Stat(skillPath); err == nil {
			out = append(out, filesystem.FileInfo{Path: filepath.ToSlash(filepath.Join(e.Name(), "SKILL.md"))})
		}
	}
	return out, nil
}
func (o osBackend) Write(context.Context, *filesystem.WriteRequest) error { return fs.ErrPermission }
func (o osBackend) Edit(context.Context, *filesystem.EditRequest) error   { return fs.ErrPermission }

func skillVersions(dir string) (map[string]string, error) {
	versions := map[string]string{}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		files := map[string][]byte{}
		_ = filepath.Walk(filepath.Join(dir, e.Name()), func(path string, info os.FileInfo, err error) error {
			if err != nil || info.IsDir() {
				return err
			}
			if info.Mode()&os.ModeSymlink != 0 {
				return fmt.Errorf("symlink_rejected")
			}
			rel, _ := filepath.Rel(dir, path)
			data, err := os.ReadFile(path)
			if err != nil {
				return err
			}
			files[filepath.ToSlash(rel)] = data
			return nil
		})
		keys := make([]string, 0, len(files))
		for k := range files {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		h := sha256.New()
		for _, k := range keys {
			h.Write([]byte(k))
			h.Write(files[k])
		}
		versions[e.Name()] = hex.EncodeToString(h.Sum(nil))
	}
	return versions, nil
}

func loadSkillHandler(ctx context.Context, cfg Config) (adk.ChatModelAgentMiddleware, map[string]string, error) {
	if cfg.SkillsDir == "" {
		return nil, map[string]string{}, nil
	}
	versions, err := skillVersions(cfg.SkillsDir)
	if err != nil {
		return nil, nil, err
	}
	backend, err := skill.NewBackendFromFilesystem(ctx, &skill.BackendFromFilesystemConfig{
		Backend: osBackend{root: cfg.SkillsDir},
		BaseDir: cfg.SkillsDir,
	})
	if err != nil {
		return nil, nil, err
	}
	listed, err := backend.List(ctx)
	if err != nil {
		return nil, nil, err
	}
	names := map[string]struct{}{}
	for _, item := range listed {
		if item.Context != "" || item.Agent != "" || item.Model != "" {
			return nil, nil, fmt.Errorf("unsupported skill override")
		}
		if _, ok := names[item.Name]; ok {
			return nil, nil, fmt.Errorf("duplicate skill name")
		}
		names[item.Name] = struct{}{}
	}
	handler, err := skill.NewMiddleware(ctx, &skill.Config{Backend: backend})
	if err != nil {
		return nil, nil, err
	}
	return handler, versions, nil
}

func loadFixedSkill(ctx context.Context, cfg Config, name string) (string, error) {
	if cfg.SkillsDir == "" {
		return "", nil
	}
	backend, err := skill.NewBackendFromFilesystem(ctx, &skill.BackendFromFilesystemConfig{
		Backend: osBackend{root: cfg.SkillsDir},
		BaseDir: cfg.SkillsDir,
	})
	if err != nil {
		return "", err
	}
	loaded, err := backend.Get(ctx, name)
	if err != nil {
		return "", err
	}
	return loaded.Content, nil
}
