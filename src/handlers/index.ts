// Per-endpoint handler functions.
//
// Each handler maps an HTTP request → an RpcCommand sent to pi → an HTTP response
// constructed from pi's preflight ack. Async work is observed by clients via the
// WS event stream; HTTP returns 200 once pi has accepted the command (not on
// completion).

export {};
