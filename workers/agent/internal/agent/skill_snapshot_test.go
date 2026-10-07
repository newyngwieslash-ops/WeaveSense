package agent

import (
	"context"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/cloudwego/eino/components/tool"
)

func TestRequiredFixedSkillFailsBeforeModel(t *testing.T) {
	for _, mode := range []Mode{ModeAnalyzeItem, ModeBriefing} {
		for _, broken := range []string{"missing", "unreadable", "hash_failure"} {
			t.Run(string(mode)+"/"+broken, func(t *testing.T) {
				root := t.TempDir()
				name := "industry-analysis"
				req := analyzeReq()
				if mode == ModeBriefing {
					name, req = "briefing-writing", briefingReq()
				}
				if broken != "missing" {
					writeSkill(t, root, name, "---\nname: "+name+"\ndescription: d\n---\n\nUse evidence.\n")
				}
				if broken == "unreadable" {
					path := filepath.Join(root, name, "SKILL.md")
					if err := os.Remove(path); err != nil {
						t.Fatal(err)
					}
					if err := os.Mkdir(path, 0o755); err != nil {
						t.Fatal(err)
					}
				}
				if broken == "hash_failure" {
					if err := os.WriteFile(filepath.Join(root, name, "oversize.txt"), make([]byte, 33*1024), 0o644); err != nil {
						t.Fatal(err)
					}
				}
				cfg, calls := scriptedModel(t, func(w http.ResponseWriter, _ *http.Request) {
					_, _ = w.Write(openaiReply(validAnalysisJSON()))
				})
				cfg.SkillsDir = root
				resp, err := Execute(context.Background(), cfg, req)
				if err != nil || resp.OK || resp.Error == nil || resp.Error.Code != "skill_unavailable" || atomic.LoadInt32(calls) != 0 {
					t.Fatalf("response=%+v err=%v calls=%d", resp, err, atomic.LoadInt32(calls))
				}
			})
		}
	}
}

func TestSkillSnapshotRetainsBytesAndRejectsUnknownResources(t *testing.T) {
	root := t.TempDir()
	writeSkill(t, root, "demo", "---\nname: demo\ndescription: d\n---\n\noriginal body\n")
	resource := filepath.Join(root, "demo", "reference.txt")
	if err := os.WriteFile(resource, []byte("original resource"), 0o644); err != nil {
		t.Fatal(err)
	}
	ctx, err := withSkillSnapshot(context.Background(), Config{SkillsDir: root})
	if err != nil {
		t.Fatal(err)
	}
	digest := skillSnapshotDigest(ctx)
	versions, err := skillVersionsFor(ctx, Config{SkillsDir: root})
	if err != nil || digest == "" || versions["demo"] == "" {
		t.Fatalf("snapshot: %v", err)
	}
	writeSkill(t, root, "demo", "---\nname: demo\ndescription: d\n---\n\nmutated body\n")
	if err := os.WriteFile(resource, []byte("mutated resource"), 0o644); err != nil {
		t.Fatal(err)
	}
	writeSkill(t, root, "late", "---\nname: late\ndescription: d\n---\n\nlate body\n")
	// Worker validates this snapshot before Execute requests it again.
	ctx, err = withSkillSnapshot(ctx, Config{SkillsDir: root})
	if err != nil || skillSnapshotDigest(ctx) != digest {
		t.Fatal("second freeze replaced the validated snapshot")
	}
	ctx = withBudget(ctx, &runBudget{toolLeft: 5})
	body, err := loadFixedSkill(ctx, Config{SkillsDir: root}, "demo")
	if err != nil || !strings.Contains(body, "original body") {
		t.Fatalf("body=%q err=%v", body, err)
	}
	used := map[string]string{}
	resourceTool := skillResourceTool(Config{SkillsDir: root}, used, nil).(tool.InvokableTool)
	got, err := resourceTool.InvokableRun(ctx, `{"skill":"demo","path":"reference.txt"}`)
	if err != nil || got != "original resource" || used["demo"] != versions["demo"] {
		t.Fatalf("resource=%q used=%v err=%v", got, used, err)
	}
	for _, args := range []string{`{"skill":"late","path":"SKILL.md"}`, `{"skill":"demo","path":"../late/SKILL.md"}`} {
		if _, err := resourceTool.InvokableRun(ctx, args); err == nil {
			t.Fatalf("accepted %s", args)
		}
	}
	if skillSnapshotDigest(ctx) != digest {
		t.Fatal("snapshot digest changed")
	}
}

func TestFixedSkillPreloadDoesNotConsumeToolBudget(t *testing.T) {
	root := t.TempDir()
	writeSkill(t, root, "industry-analysis", "---\nname: industry-analysis\ndescription: d\n---\n\nrequired rule\n")
	cfg, calls := scriptedModel(t, func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write(openaiReply(validAnalysisJSON())) })
	cfg.SkillsDir = root
	resp, err := Execute(context.Background(), cfg, analyzeReq())
	if err != nil || !resp.OK || resp.Runtime.ToolCalls != 0 || resp.Runtime.SkillVersions["industry-analysis"] == "" || atomic.LoadInt32(calls) != 1 {
		t.Fatalf("response=%+v err=%v calls=%d", resp, err, atomic.LoadInt32(calls))
	}
}

func TestResearchSkillSnapshotSurvivesSourceChangesDuringExecution(t *testing.T) {
	root := t.TempDir()
	writeSkill(t, root, "demo", "---\nname: demo\ndescription: d\n---\n\nUse reference.txt.\n")
	path := filepath.Join(root, "demo", "reference.txt")
	if err := os.WriteFile(path, []byte("ORIGINAL_RESOURCE"), 0o644); err != nil {
		t.Fatal(err)
	}
	versions, err := skillVersions(root)
	if err != nil {
		t.Fatal(err)
	}
	var step atomic.Int32
	cfg, calls := scriptedModel(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if step.Add(1) == 1 {
			if err := os.WriteFile(path, []byte("MUTATED_RESOURCE"), 0o644); err != nil {
				t.Error(err)
			}
			_, _ = w.Write([]byte(`{"id":"1","choices":[{"finish_reason":"tool_calls","message":{"role":"assistant","tool_calls":[{"id":"c1","type":"function","function":{"name":"read_skill_resource","arguments":"{\"skill\":\"demo\",\"path\":\"reference.txt\"}"}}]}}]}`))
			return
		}
		body, _ := io.ReadAll(r.Body)
		if !strings.Contains(string(body), "ORIGINAL_RESOURCE") || strings.Contains(string(body), "MUTATED_RESOURCE") {
			t.Errorf("model did not receive frozen resource: %s", body)
		}
		_, _ = w.Write(openaiReply(`{"content":"Materials are insufficient.","citations":[],"insufficient_evidence":true}`))
	})
	cfg.SkillsDir = root
	req := researchReq()
	req.Policy.MaxToolCalls = 1
	resp, err := Execute(context.Background(), cfg, req)
	if err != nil || !resp.OK || atomic.LoadInt32(calls) != 2 || resp.Runtime.SkillVersions["demo"] != versions["demo"] {
		t.Fatalf("response=%+v err=%v calls=%d", resp, err, atomic.LoadInt32(calls))
	}
}
