// checkpoint-rebind is an offline codec, with no database or network access.
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"

	"loom.local/agent/internal/agent"
)

func run(in io.Reader, out io.Writer) error {
	// One base64-encoded 256 KiB envelope plus bounded JSON framing and IDs.
	const limit = 4*((256*1024+2)/3) + 4096
	raw, err := io.ReadAll(io.LimitReader(in, limit+1))
	if err != nil || len(raw) > limit {
		return fmt.Errorf("checkpoint_rebind_invalid_input")
	}
	var request struct {
		Payload []byte `json:"payload_base64"`
		From    string `json:"from_item_id"`
		To      string `json:"to_item_id"`
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if d.Decode(&request) != nil || d.Decode(new(any)) != io.EOF {
		return fmt.Errorf("checkpoint_rebind_invalid_input")
	}
	payload, err := agent.RebindCheckpointPayload(request.Payload, request.From, request.To)
	if err != nil {
		return fmt.Errorf("checkpoint_rebind_unsupported")
	}
	return json.NewEncoder(out).Encode(struct {
		Payload []byte `json:"payload_base64"`
	}{payload})
}

func main() {
	if err := run(os.Stdin, os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, "checkpoint_rebind_failed")
		os.Exit(1)
	}
}
