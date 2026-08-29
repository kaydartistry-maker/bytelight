# MCP ownership in byte-light

Byte-light has several tool-delivery layers. They are deliberately separate:

| Layer | Owner | Delivery path |
| --- | --- | --- |
| Account apps | Model-provider account | Provider/Codex app surface |
| Claude SDK MCPs | Claude SDK lane | `.mcp.json`, in-process memory, and enabled managed servers |
| Managed house MCPs | Byte-light | DB registry, discovered and cached by `mcp-bridge.ts` |
| Native house belt | Byte-light | In-process `chat-tool-belt.ts` handlers |
| Codex house access | Byte-light's owned Codex app-server | Authenticated `/mcp/belt` Streamable HTTP session |

## Ownership rules

- API-router and BYOK runtimes receive byte-light router tools in their turn payload.
- The Codex CLI runtime does not receive that payload. Its owned app-server discovers the same surface once through `/mcp/belt`.
- The Codex app-server uses a byte-light-private Unix socket and an ephemeral process environment containing the persisted belt credential. User-global Codex sessions do not inherit the belt.
- Managed discovery is single-flight: simultaneous stale-cache consumers share one refresh.
- Tool names must be unique across native, legacy, and managed sources. Ambiguity fails discovery with both owners named instead of silently selecting one.
- Thread-bound belt tools require a live byte-light Codex turn. A missing binding is a recoverable tool error, never a fallback into an arbitrary thread.
- MCP sessions are removed on protocol teardown and reaped after six idle hours if a client disappears uncleanly.

## One-time deployment migration

The historical setup registered an entry named `bytelight` in the **Codex CLI's
user-global config**. Remove only that Codex config entry when deploying this
change. Do not remove or disable byte-light's DB-managed/global MCP registry:
API-router, Ollama, OpenRouter, and the other routed lanes still receive those
house tools through `getRouterTools()`.

The supervisor now supplies the private Codex MCP table directly to the
app-server process it owns; leaving the old Codex-global entry would make
unrelated Codex sessions continue dialing the house belt.
