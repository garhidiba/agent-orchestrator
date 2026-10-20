---
name: run
description: Start or continue ORCH supervised work in the current Claude conversation.
---

Read `${CLAUDE_PLUGIN_ROOT}/skills/agent-orch/SKILL.md` and follow its workflow with the current request. Resolve its relative references from that canonical skill directory.
Use the existing `orch` MCP server, current project root and `.orch` run state. The plugin and standalone entrypoints share the same engine, configuration, coordinator token and run IDs.
