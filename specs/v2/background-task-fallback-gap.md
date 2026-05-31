# Background Task Fallback Chain Gap

## Status

**Resolved** — the infinite proxy hang and silent swallowing for fallback models like `openai/gpt-5.5` have been addressed via hard timeouts.

## Findings

### Test Results (2025-05-23, gpt-5.5 medium variant)

| Chain | Sequence | Result |
|---|---|---|
| deep | deepseek-reasoner → gpt-5.5 → kimi → glm | ✅ deepseek-reasoner ran directly |
| unspecified-low | codex → kimi → deepseek | ✅ kimi (limit) → deepseek-v4-pro |
| **artistry** | gemini-3.1-pro → **gpt-5.5** → kimi → glm → deepseek | ❌ gpt-5.5 "completed" with no text |
| **quick** | gemini-flash → nemotron → deepseek-flash | ❌ Completed with no text output |

Two of four chains work correctly. The two failing chains both involve models that produce empty output without throwing a detectable error.

### Root Cause

The failure propagates through three layers:

#### 1. `tool/task.ts` line 211 — Empty output treated as success

```ts
return result.parts.findLast((item) => item.type === "text")?.text ?? ""
```

When the model produces no text parts (rate-limited, empty response, or internal SDK handling), `runTask()` returns an empty string. No error is thrown, so the `catchCause` handler never fires.

#### 2. `tool/task.ts` line 284-285 — Empty text injected as "completed"

```ts
Effect.tap((text) => inject("completed", text).pipe(Effect.ignore)),
```

The empty string passes through to `inject("completed", "")`, which sends a "completed" notification to the parent session.

#### 3. `background/job.ts` line 143 — Success handler marks job "completed"

```ts
onSuccess: (output) => finish(id, "completed", { output }),
```

The background job finishes with `status: "completed"` and `output: ""`. The plugin sees "completed" and **stops the fallback chain** — it never reaches kimi → glm → deepseek.

### Why It's gpt-5.5 Specific

The AI SDK's `streamText` handles HTTP 429 (rate-limit) errors differently depending on the provider. For OpenAI models:

- `maxRetries` (default 0) may not apply to HTTP errors — the SDK can exhaust internal retries and complete the stream without emitting `provider-error` or throwing
- Other providers (deepseek, kimi) surface quota errors via the `provider-error` stream event (line 525 of `session/processor.ts`) which correctly triggers the error pathway

### Contrast: Session-Level Retry (Works)

The `session/processor.ts` `Effect.retry()` wrapping handles transient errors within a single LLM call correctly:

```
llm.stream → stream drains → catchCauseIf catches errors → 
Effect.retry (SessionRetry.policy) → retries if retryable → 
if exhausted → halt() publishes Session.Event.Error
```

This works for errors that the AI SDK surfaces as exceptions. It does **not** help when the SDK silently completes with no output.

## Fix Options

### Option A: Guard empty output in `task/tool.ts` (Recommended)

In `runTask()`, treat empty text output as a failure:

```ts
const text = result.parts.findLast((item) => item.type === "text")?.text
if (text === undefined || text.trim() === "") {
  return yield* Effect.fail(new Error("Model returned no text output"))
}
return text
```

**Pros**: Minimal, targeted, catches exactly this failure mode. The `catchCause` in `background.start()` already handles error propagation.

**Cons**: Doesn't address empty responses in non-background tasks.

### Option B: Add output validation in `background/job.ts`

Check if a "completed" result has meaningful output before marking as completed:

```ts
onSuccess: (output) => {
  if (output.trim() === "") {
    return finish(id, "error", { error: "No output from model" })
  }
  return finish(id, "completed", { output })
}
```

**Pros**: Catches all background tasks, not just `task` tool.

**Cons**: Broader scope, may have false positives for tasks that legitimately return empty output.

### Option C: Add gpt-5.5 429 detection in `session/retry.ts`

**Cons**: The error never reaches `retryable()` because the stream doesn't throw — it just produces no text. This approach wouldn't help.

## Resolution (2026-05-31)

Instead of guarding empty output inside `task/tool.ts`, the root causes at the network and retry layers were addressed directly:

1. **Proxy Hangs / Network Silences**: Injected an `AbortSignal.timeout(180000)` into the AI SDK fetch wrapper (`packages/core/src/aisdk.ts`). This ensures that if the model (like `gpt-5.5`) connects but produces no text over a dead connection, it hard-fails instead of hanging forever.
2. **Infinite Slumbers**: Added a 60-second limit to the `delay()` calculation in `packages/opencode/src/session/retry.ts`. If the required exponential backoff exceeds 60s due to hard quota limits, the retry is aborted instantly. 

These two fixes combined force the `catchCause` logic to trigger, successfully pushing the error up the chain so the background job properly reports `error` and gracefully transitions to the next fallback model (e.g., `deepseek`).

## Related Files

- `packages/opencode/src/tool/task.ts` — `runTask()` (line 194-212) and background error handling (lines 278-302)
- `packages/opencode/src/background/job.ts` — job lifecycle with `onSuccess`/`onFailure` (lines 141-148)
- `packages/opencode/src/session/processor.ts` — stream processing with `halt()` and `Effect.retry()` (lines 780-843)
- `packages/opencode/src/session/retry.ts` — retryable error detection (lines 67-151)
