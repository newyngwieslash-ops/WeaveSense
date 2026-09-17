package agent

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/cloudwego/eino/adk/filesystem"
)

func writeSkill(t *testing.T, root, name, body string) {
	t.Helper()
	dir := filepath.Join(root, name)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "SKILL.md"), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestSkillsLoadAndHash(t *testing.T) {
	root := t.TempDir()
	writeSkill(t, root, "cross-source-check", "---\nname: cross-source-check\ndescription: d\n---\n\nUse search_items.\n")
	versions, err := skillVersions(root)
	if err != nil {
		t.Fatal(err)
	}
	if versions["cross-source-check"] == "" {
		t.Fatal("missing hash")
	}
	writeSkill(t, root, "cross-source-check", "---\nname: cross-source-check\ndescription: d\n---\n\nchanged\n")
	next, err := skillVersions(root)
	if err != nil {
		t.Fatal(err)
	}
	if next["cross-source-check"] == versions["cross-source-check"] {
		t.Fatal("hash should change")
	}
	handler, _, err := loadSkillHandler(context.Background(), Config{SkillsDir: root})
	if err != nil {
		t.Fatal(err)
	}
	if handler == nil {
		t.Fatal("handler")
	}
}

func TestSkillsRejectForkAndDuplicates(t *testing.T) {
	root := t.TempDir()
	writeSkill(t, root, "a", "---\nname: same\ndescription: d\ncontext: fork\n---\n\nbody\n")
	if _, _, err := loadSkillHandler(context.Background(), Config{SkillsDir: root}); err == nil {
		t.Fatal("expected fork reject")
	}
	root = t.TempDir()
	writeSkill(t, root, "a", "---\nname: same\ndescription: d\n---\n\nbody\n")
	writeSkill(t, root, "b", "---\nname: same\ndescription: d\n---\n\nbody\n")
	if _, _, err := loadSkillHandler(context.Background(), Config{SkillsDir: root}); err == nil {
		t.Fatal("expected duplicate reject")
	}
}

func TestSkillsRejectAbsolutePathOutsideRoot(t *testing.T) {
	root := t.TempDir()
	outside := filepath.Join(t.TempDir(), "secret.txt")
	if err := os.WriteFile(outside, []byte("sentinel"), 0o644); err != nil {
		t.Fatal(err)
	}
	_, err := (osBackend{root: root}).Read(context.Background(), &filesystem.ReadRequest{FilePath: outside})
	if err == nil {
		t.Fatal("expected path_escape")
	}
}

func TestSkillsRejectOversize(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "x")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "SKILL.md"), make([]byte, 33*1024), 0o644); err != nil {
		t.Fatal(err)
	}
	_, err := (osBackend{root: root}).Read(context.Background(), &filesystem.ReadRequest{FilePath: filepath.Join(dir, "SKILL.md")})
	if err == nil {
		t.Fatal("expected oversize reject")
	}
}
