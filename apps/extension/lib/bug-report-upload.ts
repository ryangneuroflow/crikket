import type { BugReportDebuggerPayload } from "@crikket/capture-core/debugger/types"
import {
  buildDebuggerArtifactForUpload,
  uploadArtifactToStorage,
} from "@crikket/capture-core/upload/client"
import type { Priority } from "@crikket/shared/constants/priorities"
import { client } from "./orpc"

export async function submitBugReportWithUploads(input: {
  attachment: Blob
  attachmentType: "video" | "screenshot"
  debuggerPayload?: BugReportDebuggerPayload
  debuggerSummary: {
    actions: number
    logs: number
    networkRequests: number
  }
  description?: string
  deviceInfo?: {
    browser?: string
    os?: string
    viewport?: string
  }
  metadata?: {
    duration?: string
    durationMs?: number
    pageTitle?: string
  }
  parentIssueRef?: string
  priority: Priority
  title?: string
  url?: string
}): Promise<Awaited<ReturnType<typeof client.bugReport.finalizeUpload>>> {
  const uploadSession = await client.bugReport.createUpload({
    attachmentType: input.attachmentType,
    captureContentType: input.attachment.type || undefined,
    description: input.description,
    deviceInfo: input.deviceInfo,
    hasDebuggerPayload: Boolean(input.debuggerPayload),
    debuggerSummary: input.debuggerSummary,
    metadata: input.metadata,
    parentIssueRef: input.parentIssueRef,
    priority: input.priority,
    title: input.title,
    url: input.url,
    visibility: "private",
  })

  const debuggerArtifact = await buildDebuggerArtifactForUpload(
    input.debuggerPayload
  )
  const uploads: Promise<void>[] = [
    uploadArtifactToStorage(uploadSession.captureUpload, input.attachment),
  ]

  if (uploadSession.debuggerUpload && debuggerArtifact) {
    uploads.push(
      uploadArtifactToStorage(
        uploadSession.debuggerUpload,
        debuggerArtifact.blob,
        {
          contentEncoding: debuggerArtifact.contentEncoding,
        }
      )
    )
  }

  await Promise.all(uploads)

  return client.bugReport.finalizeUpload({
    id: uploadSession.bugReportId,
    captureContentType: input.attachment.type || undefined,
    captureSizeBytes: input.attachment.size,
    debuggerContentEncoding: debuggerArtifact?.contentEncoding,
    debuggerSizeBytes: debuggerArtifact?.blob.size,
  })
}
