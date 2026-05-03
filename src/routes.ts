// REST route dispatcher.
//
// Hand-rolled regex dispatcher table — no router library. The full v1 endpoint
// set is small (see CLAUDE.md §Bridge architecture):
//
//   POST /api/sessions
//   GET  /api/sessions
//   GET  /api/sessions/:id/state
//   GET  /api/sessions/:id/messages
//   POST /api/sessions/:id/prompt
//   POST /api/sessions/:id/steer
//   POST /api/sessions/:id/follow_up
//   POST /api/sessions/:id/abort
//   POST /api/sessions/:id/model
//   POST /api/sessions/:id/compact
//   POST /api/sessions/:id/bash
//   GET  /api/models
//   GET  /api/commands

export {};
