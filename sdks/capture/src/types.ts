import type * as eagerCapture from "./eager"

export type CaptureType = "video" | "screenshot"
export type CapturePriority = "none" | "low" | "medium" | "high" | "critical"
export type CaptureReportVisibility = "public" | "private"

export type DebuggerActionType =
  | "click"
  | "input"
  | "change"
  | "submit"
  | "keydown"
  | "navigation"

export interface DebuggerActionEvent {
  kind: "action"
  timestamp: number
  actionType: DebuggerActionType | string
  target?: string
  metadata?: Record<string, unknown>
}

export interface DebuggerConsoleEvent {
  kind: "console"
  timestamp: number
  level: "log" | "info" | "warn" | "error" | "debug"
  message: string
  metadata?: Record<string, unknown>
}

export interface DebuggerNetworkEvent {
  kind: "network"
  timestamp: number
  method: string
  url: string
  status?: number
  duration?: number
  requestHeaders?: Record<string, string>
  responseHeaders?: Record<string, string>
  requestBody?: string
  responseBody?: string
}

export type DebuggerEvent =
  | DebuggerActionEvent
  | DebuggerConsoleEvent
  | DebuggerNetworkEvent

export interface BugReportDebuggerPayload {
  actions: Array<{
    type: string
    target?: string
    timestamp: string
    offset: number | null
    metadata?: Record<string, unknown>
  }>
  logs: Array<{
    level: "log" | "info" | "warn" | "error" | "debug"
    message: string
    timestamp: string
    offset: number | null
    metadata?: Record<string, unknown>
  }>
  networkRequests: Array<{
    method: string
    url: string
    status?: number
    duration?: number
    requestHeaders?: Record<string, string>
    responseHeaders?: Record<string, string>
    requestBody?: string
    responseBody?: string
    timestamp: string
    offset: number | null
  }>
}

export interface CaptureInitOptions {
  key: string
  host?: string
  autoMount?: boolean
  mountTarget?: HTMLElement
  submitPath?: string
  zIndex?: number
  submitTransport?: CaptureSubmitTransport
}

export interface CaptureRuntimeConfig {
  key: string
  host: string
  submitPath: string
  zIndex: number
}

export interface CaptureDebuggerSummary {
  actions: number
  logs: number
  networkRequests: number
}

/**
 * A Jira field the host server wants the reporter to fill in, as served by
 * `/api/embed/jira-fields`. Only present when the org forwards to Jira and
 * the target project requires fields Crikket can't fill on its own.
 */
export interface JiraReporterField {
  id: string
  name: string
  required: boolean
  type: "select" | "multiselect" | "text" | "number"
  options?: Array<{ id: string; label: string }>
  /** Admin-configured default, already in submit shape (`{ id }` for options). */
  defaultValue?: unknown
}

export type CaptureForwardTarget = "github" | "jira"

/** Which trackers the host org forwards to, as served by `/api/embed/integrations`. */
export interface CaptureIntegrations {
  github: { configured: boolean }
  jira: { configured: boolean; fields: JiraReporterField[] }
}

export interface CaptureSubmissionDraft {
  title: string
  description: string
  priority: CapturePriority
  visibility?: CaptureReportVisibility
  /**
   * Tracker to forward this report to. Defaults to Jira when configured,
   * else GitHub. Omitted when the org has neither, in which case the server
   * forwards to whatever it has (nothing).
   */
  forwardTarget?: CaptureForwardTarget
  /**
   * Values for the JiraReporterFields, keyed by Jira field id. Option
   * fields carry `{ id }` (or an array of them); text/number carry the
   * primitive. The server re-validates against Jira's create metadata.
   */
  jiraFields?: Record<string, unknown>
  /**
   * Optional reference to an existing issue in the host's tracker. GitHub
   * forms (issue URL, `#<number>`, `<number>`) link the new issue as a
   * sub-issue; Jira forms (`ABC-123` or a `/browse/ABC-123` URL) set the
   * parent or fall back to an issue link. The server validates and falls
   * back to a top-level issue on any parse error.
   */
  parentIssueRef?: string
}

export interface CaptureSubmitRequest {
  config: CaptureRuntimeConfig
  report: {
    captureType: CaptureType
    title: string
    description: string
    priority: CapturePriority
    visibility: CaptureReportVisibility
    pageUrl: string
    pageTitle: string
    durationMs: number | null
    deviceInfo?: {
      browser?: string
      os?: string
      viewport?: string
    }
    debuggerPayload?: BugReportDebuggerPayload
    debuggerSummary: CaptureDebuggerSummary
    media: Blob
    parentIssueRef?: string
    jiraFields?: Record<string, unknown>
    forwardTarget?: CaptureForwardTarget
  }
}

export interface CaptureSubmitResult {
  shareUrl?: string
  reportId?: string
  // Set when the host server forwarded the report to a configured GitHub
  // integration and the issue was created successfully. Surfaces in the SDK
  // success modal.
  githubIssueUrl?: string
  // Same contract for a configured Jira integration.
  jiraIssueUrl?: string
  raw?: unknown
}

export type CaptureSubmitTransport = (
  request: CaptureSubmitRequest
) => Promise<CaptureSubmitResult>

export interface CapturedMedia {
  blob: Blob
  captureType: CaptureType
  durationMs: number | null
  objectUrl: string
}

export interface ReviewSnapshot {
  debuggerPayload?: BugReportDebuggerPayload
  warnings: string[]
  debuggerSummary: CaptureDebuggerSummary
}

export interface BridgePayload {
  source: string
  event?: unknown
  events?: unknown[]
}

export interface RecordingController {
  startedAt: number
  finished: Promise<{
    blob: Blob
    durationMs: number
  }>
  stop: () => Promise<{
    blob: Blob
    durationMs: number
  }>
  abort: () => void
}

export interface DebuggerSession {
  sessionId: string
  captureType: CaptureType
  startedAt: number
  recordingStartedAt: number | null
  events: DebuggerEvent[]
}

export interface CaptureRuntimeController {
  open: () => void
  close: () => void
  destroy: () => void
  mount: (target?: HTMLElement) => void
  unmount: () => void
  startRecording: () => Promise<{ startedAt: number }>
  stopRecording: () => Promise<Blob | null>
  takeScreenshot: () => Promise<Blob | null>
  submit: (draft: CaptureSubmissionDraft) => Promise<CaptureSubmitResult>
  reset: () => void
  isInitialized: () => boolean
  getConfig: () => CaptureRuntimeConfig | null
}

export type CaptureGlobalApi = typeof eagerCapture
