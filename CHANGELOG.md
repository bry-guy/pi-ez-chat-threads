# Changelog

All notable changes to this project will be documented in this file.

## [0.1.0] - 2026-05-22

### Added
- Initial `pi-ez-chat-threads` package.
- `/chat-thread` command for creating persistent Discord thread-backed pi-chat sessions.
- Session-scoped thread reuse so repeated calls return the same durable thread by default.
- Config persistence, workspace seeding, session forking, and single-thread tmux worker spawn.
- Smoke tests for config mutation, thread reuse, workspace seeding, and worker command generation.
