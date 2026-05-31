import { describe, expect, test, mock, afterEach } from "bun:test"
import { prepareOptions } from "../src/aisdk"
import { ModelV2 } from "../src/model"
import { ProviderV2 } from "../src/provider"

describe("AISDK prepareOptions", () => {
  const originalTimeout = AbortSignal.timeout

  afterEach(() => {
    AbortSignal.timeout = originalTimeout
  })

  test("enforces a default 180-second fetch timeout if none is provided", async () => {
    let timeoutMs: number | undefined

    AbortSignal.timeout = mock((ms: number) => {
      timeoutMs = ms
      return originalTimeout(ms)
    })

    const modelInfo = {
      id: "test-model" as ModelV2.ID,
      providerID: "test-provider" as ProviderV2.ID,
      apiID: "test-api-id" as ModelV2.ID,
      endpoint: { type: "aisdk", package: "@ai-sdk/openai" },
      options: {
        headers: {},
        body: {},
        aisdk: {
          provider: {
            // Note: timeout is intentionally NOT provided
          },
          request: {}
        }
      }
    } as unknown as ModelV2.Info

    const options = prepareOptions(modelInfo, "@ai-sdk/openai")
    
    // We expect the wrapper to be created
    expect(typeof options.fetch).toBe("function")

    // Call the wrapper fetch with a mock customFetch
    let receivedSignal: AbortSignal | undefined
    options.fetch = options.fetch // actually it's stored in options.fetch
    
    // Execute the fetch wrapper, which should trigger AbortSignal.timeout
    options.fetch("https://test.local", {
      signal: new AbortController().signal
    }).catch(() => {})

    // The default timeout should be exactly 180000ms (3 minutes)
    expect(timeoutMs).toBe(180000)
  })
})
