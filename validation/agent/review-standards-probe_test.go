package agent

import (
 "context"
 "encoding/json"
 "net/http"
 "net/http/httptest"
 "os"
 "path/filepath"
 "sync/atomic"
 "sync"
 "testing"
 "github.com/cloudwego/eino/adk/filesystem"
)

func TestReviewStandardsResearchBudget(t *testing.T) {
 var calls atomic.Int32
 var maxTokensSeen atomic.Bool
 model := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter,r *http.Request){
  n:=calls.Add(1)
  var body map[string]any
  _=json.NewDecoder(r.Body).Decode(&body)
  if body["max_tokens"]!=nil || body["max_completion_tokens"]!=nil { maxTokensSeen.Store(true) }
  w.Header().Set("Content-Type","application/json")
  if n==1 { _,_=w.Write([]byte(`{"id":"1","choices":[{"finish_reason":"tool_calls","message":{"role":"assistant","tool_calls":[{"id":"c1","type":"function","function":{"name":"search_items","arguments":"{\"query\":\"x\"}"}}]}}]}`)); return }
  content:=`{"content":"no evidence","citations":[],"insufficient_evidence":true}`
  _=json.NewEncoder(w).Encode(map[string]any{"id":"2","choices":[]any{map[string]any{"finish_reason":"stop","message":map[string]any{"role":"assistant","content":content}}},"usage":map[string]any{"prompt_tokens":30,"completion_tokens":10,"total_tokens":40}})
 }))
 defer model.Close()
 data:=httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter,r *http.Request){ _,_=w.Write([]byte(`{"items":[]}`)) }))
 defer data.Close()
 req:=researchReq(); req.Policy.MaxModelCalls=1
 resp,err:=Execute(context.Background(),Config{ModelBaseURL:model.URL+"/v1",ModelName:"test",ModelAPIKey:"test",DataURL:data.URL,DataToken:"test"},req)
 t.Logf("actual_http_model_calls=%d policy_calls=%d reported_runtime=%+v max_output_transmitted=%v result_ok=%v err=%v",calls.Load(),req.Policy.MaxModelCalls,resp.Runtime,maxTokensSeen.Load(),resp.OK,err)
 if calls.Load()>1 { t.Error("policy max_model_calls bypassed") }
 if !maxTokensSeen.Load() { t.Error("policy max_output_tokens_per_call not sent") }
}

func TestReviewStandardsSkillRoot(t *testing.T) {
 root:=t.TempDir()
 outside:=filepath.Join(t.TempDir(),"outside.txt")
 if err:=os.WriteFile(outside,[]byte("outside sentinel"),0600);err!=nil {t.Fatal(err)}
 got,err:=(osBackend{root:root}).Read(context.Background(),&filesystem.ReadRequest{FilePath:outside})
 if err==nil {t.Fatalf("read outside configured skills root: %s",got.Content)}
}

func TestReviewStandardsEventRace(t *testing.T) {
 events:=[]RuntimeEvent{}
 ctx:=withBudget(context.Background(),&runBudget{toolLeft:4})
 gate:=make(chan struct{})
 var wg sync.WaitGroup
 for i:=0;i<4;i++ {wg.Add(1);go func(){defer wg.Done();_,_=guardedTool(ctx,&events,"search_items",func()(string,error){<-gate;return "ok",nil})}()}
 close(gate);wg.Wait()
 t.Logf("tool events=%d expected=4",len(events))
}
