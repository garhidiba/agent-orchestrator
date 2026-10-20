---
name: init
description: Initialize or complete the current client project's ORCH configuration.
---

Read `${CLAUDE_PLUGIN_ROOT}/skills/agent-orch/SKILL.md` and follow its init workflow with explicit init intent and the current request. Resolve its relative references from that canonical skill directory.
Use the existing `orch` MCP server and current client Git project. The plugin and standalone entrypoints share the same engine, configuration and coordinator token.
