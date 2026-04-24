import { describe, expect, it } from "bun:test"

import { VIDEO_LOOKBACK_MS } from "../src/constants"
import {
  getCaptureSdk,
  sdkTestState,
  setupCaptureSdkTestHooks,
  waitFor,
} from "./lib/sdk-test-harness"

setupCaptureSdkTestHooks()

describe("capture SDK recording flow", () => {
  it("completes the recording flow and resets cleanly without double-finalizing", async () => {
    const capture = getCaptureSdk()

    capture.init({
      key: "crk_recording_flow",
      host: "https://api.crikket.io",
    })

    // The collector is installed eagerly at init — not lazily on first capture —
    // so the ring buffer has been filling since SDK bootstrap. That's why the
    // video session below gets a non-zero lookback: there's something to look
    // back at.
    expect(sdkTestState.installCalls).toBe(1)

    const startResult = await capture.startRecording()
    expect(startResult).toEqual({
      startedAt: 1_700_000_000_000,
    })
    expect(sdkTestState.startSessionCalls).toEqual([
      {
        captureType: "video",
        lookbackMs: VIDEO_LOOKBACK_MS,
      },
    ])
    expect(sdkTestState.markRecordingStartedCalls).toEqual([1_700_000_000_000])
    expect(sdkTestState.uiHidden).toEqual([true])

    const recordingBlob = await capture.stopRecording()
    expect(recordingBlob).toBe(sdkTestState.recordingBlob)
    expect(sdkTestState.recordingStopCalls).toBe(1)
    expect(sdkTestState.finalizeSessionCalls).toBe(1)
    expect(sdkTestState.uiShowReviewInputs).toHaveLength(1)
    expect(sdkTestState.uiShowReviewInputs[0]).toMatchObject({
      media: {
        blob: sdkTestState.recordingBlob,
        captureType: "video",
        durationMs: sdkTestState.recordingDurationMs,
      },
    })
    expect(sdkTestState.uiHidden).toEqual([true, false])

    await waitFor(() => sdkTestState.finalizeSessionCalls === 1)

    capture.reset()
    expect(sdkTestState.clearSessionCalls).toBe(1)
    expect(sdkTestState.objectUrlsRevoked).toEqual(["blob:mock-1"])

    capture.destroy()
    expect(sdkTestState.disposeCalls).toBe(1)
    expect(sdkTestState.uiUnmounts).toBe(1)
    expect(capture.isInitialized()).toBe(false)
  })
})
