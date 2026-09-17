package agent

import (
 "context"
 "encoding/json"
 "fmt"
 "net/http"
 "net/http/httptest"
 "sync/atomic"
 "testing"
 "io"
 "time"
 "path/filepath"
 "github.com/cloudwego/eino/schema"
)

func TestThirdPositiveSkillBudget(t *testing.T) {
 root:=t.TempDir();writeSkill(t,root,"demo","---\nname: demo\ndescription: demo\n---\n\nSKILL_SENTINEL\n")
 t.Logf("rawroot=%q",root)
 resolved,e1:=filepath.EvalSymlinks(root);absolute,e2:=filepath.Abs(resolved);rel,e3:=filepath.Rel(absolute,resolved)
 t.Logf("resolved=%q abs=%q rel=%q isAbs=%v errors=%v/%v/%v inRoot=%v",resolved,absolute,rel,filepath.IsAbs(rel),e1,e2,e3,(osBackend{root:root}).inRoot(root))
 var calls atomic.Int32;var receivedTools atomic.Int32
 srv:=httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter,r *http.Request){
  n:=calls.Add(1)
  var body struct{Messages []struct{Role string `json:"role"`;Content string `json:"content"`} `json:"messages"`};_ =json.NewDecoder(r.Body).Decode(&body)
  var count int32;for _,m:=range body.Messages {if m.Role=="tool" && len(m.Content)>0 {count++}};receivedTools.Store(count)
  w.Header().Set("Content-Type","application/json")
  if n<=2 {_,_=fmt.Fprintf(w,`{"id":"%d","choices":[{"finish_reason":"tool_calls","message":{"role":"assistant","tool_calls":[{"id":"c%d","type":"function","function":{"name":"skill","arguments":"{\"skill\":\"demo\"}"}}]}}]}`,n,n);return}
  _,_=w.Write(openaiReply(`{"content":"no evidence","citations":[],"insufficient_evidence":true}`))
 }));defer srv.Close()
 req:=researchReq();req.Policy.MaxToolCalls=1
 resp,err:=Execute(context.Background(),Config{ModelBaseURL:srv.URL+"/v1",ModelName:"fake",ModelAPIKey:"fake",SkillsDir:root},req)
 t.Logf("policy_tool_calls=1 received_skill_results=%d model_calls=%d runtime=%+v ok=%v err=%v",receivedTools.Load(),calls.Load(),resp.Runtime,resp.OK,err)
 if resp.Error!=nil {t.Logf("response_error=%+v",resp.Error)}
 if calls.Load()==0 {t.Fatal("probe blocked before model: skill loading broken")}
 if receivedTools.Load()>1 {t.Error("positive skill budget bypassed after exhaustion")}
 if resp.OK && resp.Runtime!=nil && receivedTools.Load()>0 && resp.Runtime.ToolCalls==0 {t.Error("executed skills not counted")}
 if resp.OK && resp.Runtime!=nil && resp.Runtime.InputTokens==nil {t.Error("known vendor usage discarded")}
}

func TestThirdStreamLateErrorAudit(t *testing.T) {
 srv:=httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter,r *http.Request){
  w.Header().Set("Content-Type","text/event-stream")
  _,_=w.Write([]byte("data: {\"id\":\"s1\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"ok\"},\"finish_reason\":null}]}\n\ndata: {invalid-json}\n\n"))
 }));defer srv.Close()
 inner,err:=newChatModel(Config{ModelBaseURL:srv.URL+"/v1",ModelName:"fake",ModelAPIKey:"fake"},time.Second,12);if err!=nil {t.Fatal(err)}
 events:=[]RuntimeEvent{};cm:=budgetModel{inner:inner,budget:&runBudget{modelLeft:1},events:&events,name:"fake"}
 stream,err:=cm.Stream(context.Background(),[]*schema.Message{schema.UserMessage("hello")});if err!=nil {t.Fatal(err)}
 var recvErr error
 for {_,err=stream.Recv();if err!=nil {recvErr=err;break}};stream.Close()
 t.Logf("recv_error=%v audit_events=%+v",recvErr,events)
 if recvErr==nil || recvErr==io.EOF {t.Fatal("probe did not reach stream parse failure")}
 if len(events)>0 && events[0].OK {t.Error("stream parse failure audited as successful")}
}
