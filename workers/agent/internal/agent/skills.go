package agent

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/cloudwego/eino/adk"
	"github.com/cloudwego/eino/adk/filesystem"
	"github.com/cloudwego/eino/adk/middlewares/skill"
	"github.com/cloudwego/eino/components/tool"
	toolutils "github.com/cloudwego/eino/components/tool/utils"
	"github.com/cloudwego/eino/schema"
)

type osBackend struct {
	root string
	// Non-nil files are an immutable run snapshot; reads never revisit the disk.
	files    map[string]string
	versions map[string]string
	digest   string
}

type skillSnapshotKey struct{}

func withSkillSnapshot(ctx context.Context, cfg Config) (context.Context, error) {
	if _, ok := ctx.Value(skillSnapshotKey{}).(osBackend); ok {
		return ctx, nil
	}
	if cfg.SkillsDir == "" {
		return ctx, nil
	}
	backend, err := readSkillSnapshot(cfg.SkillsDir)
	if err != nil {
		return ctx, err
	}
	return context.WithValue(ctx, skillSnapshotKey{}, backend), nil
}

func skillBackendFor(ctx context.Context, cfg Config) (osBackend, error) {
	if snapshot, ok := ctx.Value(skillSnapshotKey{}).(osBackend); ok {
		return snapshot, nil
	}
	return readSkillSnapshot(cfg.SkillsDir)
}

func skillSnapshotDigest(ctx context.Context) string {
	snapshot, _ := ctx.Value(skillSnapshotKey{}).(osBackend)
	return snapshot.digest
}

func skillVersionsFor(ctx context.Context, cfg Config) (map[string]string, error) {
	backend, err := skillBackendFor(ctx, cfg)
	return backend.versions, err
}

// List is metadata discovery; Get is the actual Skill tool execution boundary.
type budgetSkillBackend struct {
	skill.Backend
	versions map[string]string
	used     map[string]string
}

func (b *budgetSkillBackend) Get(ctx context.Context, name string) (skill.Skill, error) {
	budget := budgetFrom(ctx)
	if budget == nil || !budget.takeTool() {
		return skill.Skill{}, fmt.Errorf("budget_exceeded")
	}
	loaded, err := b.Backend.Get(ctx, name)
	if err == nil {
		budget.mu.Lock()
		b.used[name] = b.versions[name]
		budget.mu.Unlock()
	}
	return loaded, err
}

func (o osBackend) LsInfo(context.Context, *filesystem.LsInfoRequest) ([]filesystem.FileInfo, error) {
	return nil, fmt.Errorf("unsupported_skill_operation: ls")
}
func (o osBackend) inRoot(path string) bool {
	root, err := filepath.EvalSymlinks(o.root)
	if err != nil {
		return false
	}
	root, err = filepath.Abs(root)
	if err != nil {
		return false
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return false
	}
	resolved, err := filepath.EvalSymlinks(abs)
	if err != nil {
		return false
	}
	rel, err := filepath.Rel(root, resolved)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel)
}

func (o osBackend) Read(_ context.Context, req *filesystem.ReadRequest) (*filesystem.FileContent, error) {
	path := filepath.Clean(req.FilePath)
	if o.files != nil {
		abs, err := filepath.Abs(path)
		if err != nil {
			return nil, err
		}
		rel, err := filepath.Rel(o.root, abs)
		if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.IsAbs(rel) {
			return nil, fmt.Errorf("path_escape")
		}
		content, ok := o.files[abs]
		if !ok {
			return nil, fs.ErrNotExist
		}
		return &filesystem.FileContent{Content: content}, nil
	}
	if !o.inRoot(path) {
		return nil, fmt.Errorf("path_escape")
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, 32*1024+1))
	if err != nil {
		return nil, err
	}
	if len(data) > 32*1024 {
		return nil, fmt.Errorf("skill_too_large")
	}
	return &filesystem.FileContent{Content: string(data)}, nil
}
func (o osBackend) GrepRaw(context.Context, *filesystem.GrepRequest) ([]filesystem.GrepMatch, error) {
	return nil, fmt.Errorf("unsupported_skill_operation: grep")
}
func (o osBackend) GlobInfo(_ context.Context, req *filesystem.GlobInfoRequest) ([]filesystem.FileInfo, error) {
	root := req.Path
	if o.files != nil {
		abs, err := filepath.Abs(root)
		if err != nil || abs != o.root {
			return nil, fmt.Errorf("path_escape")
		}
		var out []filesystem.FileInfo
		for name := range o.versions {
			if _, ok := o.files[filepath.Join(o.root, name, "SKILL.md")]; ok {
				out = append(out, filesystem.FileInfo{Path: filepath.ToSlash(filepath.Join(name, "SKILL.md"))})
			}
		}
		sort.Slice(out, func(i, j int) bool { return out[i].Path < out[j].Path })
		return out, nil
	}
	if !o.inRoot(root) {
		return nil, fmt.Errorf("path_escape")
	}
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
	backend, err := readSkillSnapshot(dir)
	return backend.versions, err
}

func readSkillSnapshot(dir string) (osBackend, error) {
	// ponytail: copy approved packages once per run; share content-addressed snapshots if package volume makes this costly.
	root, err := filepath.Abs(dir)
	if err != nil {
		return osBackend{}, err
	}
	snapshot := osBackend{root: root, files: map[string]string{}}
	versions := map[string]string{}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return osBackend{}, err
	}
	for _, e := range entries {
		if e.Type()&os.ModeSymlink != 0 {
			return osBackend{}, fmt.Errorf("symlink_rejected")
		}
		if !e.IsDir() {
			continue
		}
		files := map[string][]byte{}
		err = filepath.Walk(filepath.Join(dir, e.Name()), func(path string, info os.FileInfo, err error) error {
			if err != nil || info.IsDir() {
				return err
			}
			if info.Mode()&os.ModeSymlink != 0 {
				return fmt.Errorf("symlink_rejected")
			}
			rel, _ := filepath.Rel(dir, path)
			if len(files) >= 128 {
				return fmt.Errorf("skill_file_limit")
			}
			content, err := (osBackend{root: dir}).Read(context.Background(), &filesystem.ReadRequest{FilePath: path})
			if err != nil {
				return err
			}
			files[filepath.ToSlash(rel)] = []byte(content.Content)
			abs, err := filepath.Abs(path)
			if err != nil {
				return err
			}
			snapshot.files[abs] = content.Content
			return nil
		})
		if err != nil {
			return osBackend{}, err
		}
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
	snapshot.versions = versions
	names := make([]string, 0, len(versions))
	for name := range versions {
		names = append(names, name)
	}
	sort.Strings(names)
	h := sha256.New()
	for _, name := range names {
		fmt.Fprintf(h, "%s\x00%s\n", name, versions[name])
	}
	snapshot.digest = hex.EncodeToString(h.Sum(nil))
	return snapshot, nil
}

func loadSkillHandler(ctx context.Context, cfg Config) (adk.ChatModelAgentMiddleware, map[string]string, error) {
	if cfg.SkillsDir == "" {
		return nil, map[string]string{}, nil
	}
	fsBackend, err := skillBackendFor(ctx, cfg)
	if err != nil {
		return nil, nil, err
	}
	backend, err := skill.NewBackendFromFilesystem(ctx, &skill.BackendFromFilesystemConfig{
		Backend: fsBackend,
		BaseDir: fsBackend.root,
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
	used := map[string]string{}
	handler, err := skill.NewMiddleware(ctx, &skill.Config{Backend: &budgetSkillBackend{Backend: backend, versions: fsBackend.versions, used: used}})
	if err != nil {
		return nil, nil, err
	}
	return handler, used, nil
}

func loadFixedSkill(ctx context.Context, cfg Config, name string) (string, error) {
	if cfg.SkillsDir == "" {
		return "", nil
	}
	// Host policy preload is not a model-selected tool call.
	fsBackend, err := skillBackendFor(ctx, cfg)
	if err != nil {
		return "", err
	}
	backend, err := skill.NewBackendFromFilesystem(ctx, &skill.BackendFromFilesystemConfig{
		Backend: fsBackend,
		BaseDir: fsBackend.root,
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

func skillResourceTool(cfg Config, used map[string]string, events *[]RuntimeEvent) tool.BaseTool {
	return toolutils.NewTool(&schema.ToolInfo{Name: "read_skill_resource", Desc: "Read a relative resource from an installed read-only Skill package", ParamsOneOf: schema.NewParamsOneOfByParams(map[string]*schema.ParameterInfo{
		"skill": {Type: schema.String, Required: true}, "path": {Type: schema.String, Required: true},
	})}, func(ctx context.Context, in map[string]string) (string, error) {
		return guardedTool(ctx, events, "read_skill_resource", func() (string, error) {
			name, path := in["skill"], in["path"]
			if name == "" || strings.ContainsAny(name, "/\\:") || name == ".." || name == "." || path == "" || filepath.IsAbs(path) || filepath.VolumeName(path) != "" {
				return "", fmt.Errorf("path_escape")
			}
			backend, err := skillBackendFor(ctx, cfg)
			if err != nil {
				return "", err
			}
			version, ok := backend.versions[name]
			if !ok {
				return "", fs.ErrNotExist
			}
			if _, ok := backend.files[filepath.Join(backend.root, name, "SKILL.md")]; !ok {
				return "", fs.ErrNotExist
			}
			backend.root = filepath.Join(backend.root, name)
			data, err := backend.Read(ctx, &filesystem.ReadRequest{FilePath: filepath.Join(backend.root, path)})
			if err != nil {
				return "", err
			}
			b := budgetFrom(ctx)
			b.mu.Lock()
			used[name] = version
			b.mu.Unlock()
			return data.Content, nil
		})
	})
}
