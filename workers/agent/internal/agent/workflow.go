package agent

import "context"

// Execute is implemented in Task 6. Task 5 only needs a bindable function.
func Execute(ctx context.Context, cfg Config, req ExecuteRequest) (ExecuteResponse, error) {
	_ = ctx
	_ = cfg
	return ExecuteResponse{
		SchemaVersion: schemaVersion,
		RunID:         req.RunID,
		OK:            false,
		Error: &ExecuteError{
			Code:    "agent_unconfigured",
			Message: "workflow not implemented",
		},
	}, nil
}
