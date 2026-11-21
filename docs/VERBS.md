# Verbs

Every operation `@inixiative/secret-scratch` performs has one verb, one public name, and one implementation. `tests/verbs.test.ts` enforces that every exported function and class appears in this file and that `src/index.ts` uses explicit named exports.

## Public API

| Verb | Name | What it does |
| --- | --- | --- |
| hold and use | `SecretScratchPad` | Manage per-thread 0600 scratch pads: lift secrets out of text, list pending references, write/env/pipe/use values, consume or clear blocks, and scrub held values from text. |
| format | `formatScratchRef` | Format a `ScratchRef` as `†<message>.<n>` inside its own thread or `†<thread>/<message>.<n>` across threads. |
| parse | `parseScratchRef` | Parse a scratch pad reference string into a validated `ScratchRef`, resolving short refs against the caller's thread. |
| detect | `buildShapedLiftPatterns` | Build global lift regexes from shaped secret patterns with word-boundary and digit guards against ordinary identifiers. |
| detect | `contextSecretHits` | Count context-dependent credential patterns (Authorization headers, URL passwords, `KEY=value`) remaining in plain text. |
| scrub | `scrubSecrets` | Replace known shaped and context-dependent secret patterns in text with typed `[REDACTED:...]` placeholders. |
| gate | `isPrivatePath` | Check whether a path has a `.private` segment, ends in `.private`, contains `.private.`, or matches an extra private glob. |
| gate | `privatePathDenial` | Return a refusal message if a tool call targets a private path, a pad-written held file, or the scratch pad directory itself. |
| gate | `privatePathGate` | Wrap `privatePathDenial` as a `ToolGate` returning `{ behavior: 'allow' }` or `{ behavior: 'deny', message }`. |
| confine | `scratchTarget` | Resolve a tool-supplied target path inside `cwd`, rejecting workspace escapes, symlinks out of `cwd`, and guarded version-control or agent-config directories. |
| serve MCP | `createSecretScratchMcpHandler` | Create a pure JSON-RPC 2.0 MCP request handler exposing `secret_scratch` and `secret_pipe` over a `SecretScratchPad`. |
| serve MCP | `serveSecretScratchMcp` | Run the stdio JSON-RPC 2.0 MCP server loop on `stdin`/`stdout` (or supplied streams). |
| proxy ACP | `createAcpProxy` | Create a stateful ACP JSON-RPC message interceptor that injects the MCP server, lifts `$$word` and shaped secrets on `session/prompt`, blocks private path reads, and scrubs outgoing updates. |
| proxy ACP | `runAcpProxy` | Spawn an ACP agent subprocess and transparently proxy NDJSON JSON-RPC frames through `createAcpProxy`. |
| notify | `secretNotice` | Format a plain-text notice when secrets were recognised by shape or credential-like text remains unmarked. |
| fail | `SecretScratchError` | Error class whose message names references and paths only, never a secret value. |

Constants: `SECRET_MARKER`, `SECRET_REFERENCE_PATTERN`, `SECRET_SCRATCH_GUIDANCE`, `SHAPED_SECRETS`, `CONTEXT_SECRETS`, `SHAPED_SECRET_PATTERNS`, `SECRET_SCRATCH_TOOL_NAME`, `SECRET_PIPE_TOOL_NAME`, `SECRET_SCRATCH_TOOLS`.
