import { gunzipSync } from "node:zlib"
import { db } from "@crikket/db"
import { bugReport } from "@crikket/db/schema/bug-report"
import { reportNonFatalError } from "@crikket/shared/lib/errors"
import { eq } from "drizzle-orm"
import {
  getJiraIntegrationCredentials,
  type JiraIntegrationCredentials,
} from "./jira-integration-config"
import { getStorageProvider } from "./storage"

const MAX_LOG_LINES = 50
const MAX_NETWORK_ROWS = 50
const MAX_ACTION_ROWS = 50
const MAX_MESSAGE_LEN = 400
// Jira caps `summary` at 255 characters and `description` at 32,767.
const MAX_SUMMARY_LEN = 255
const MAX_DESCRIPTION_LEN = 32_000
// Jira Cloud's default per-attachment ceiling is far higher, but Data Center
// installs commonly sit at 10–50MB. 40MB matches the GitHub integration so
// the same capture behaves the same way on either target.
const MAX_ATTACHMENT_BYTES = 40 * 1024 * 1024
// REST API v2 accepts `description` as Jira wiki markup, which both Cloud and
// Data Center render. v3 requires Atlassian Document Format (ADF) and is
// Cloud-only, so v2 is the portable choice.
const JIRA_API_BASE = "/rest/api/2"
const PARENT_LINK_TYPE = "Relates"
const EPIC_NAME_RE = /epic/i
const SUBTASK_TYPE_CACHE_TTL_MS = 10 * 60 * 1000
// Fields we send opportunistically. Jira rejects the whole create when a
// field isn't on the project's create screen ("Field 'priority' cannot be
// set"), so these are stripped and the create retried when Jira names them.
const OPTIONAL_CREATE_FIELDS = ["priority", "labels", "parent"] as const

const ISSUE_KEY_RE = /^([A-Z][A-Z0-9_]*)-(\d+)$/i
// https://acme.atlassian.net/browse/ABC-123 (tolerate a `?...`/`#...` tail
// and a context path before /browse/ for Data Center).
const BROWSE_URL_RE =
  /^https?:\/\/[^/\s]+(?:\/[^\s?#]*)?\/browse\/([A-Z][A-Z0-9_]*-\d+)(?:[/?#].*)?$/i

interface DeviceInfo {
  browser?: string
  os?: string
  viewport?: string
}

interface ReportMetadata {
  duration?: string
  durationMs?: number
  pageTitle?: string
  sdkVersion?: string
  submittedVia?: string
}

type AttachmentKind = "capture" | "debugger"

interface AttachmentResult {
  kind: AttachmentKind
  label: string
  filename: string
  /** Set when the artifact was uploaded successfully. */
  attached?: boolean
  /** Set when upload was skipped because of size. */
  tooLargeBytes?: number
  /** Set when upload failed for any other reason. */
  error?: string
}

export interface CreatedJiraIssue {
  key: string
  browseUrl: string
  /** Credentials captured for the follow-up attachment phase. */
  credentials: JiraIntegrationCredentials
  /** Resolved parent key when the reporter supplied one and the link stuck. */
  parentIssueKey: string | null
}

/**
 * Parsed representation of a reporter-supplied parent-issue reference in
 * Jira form. We accept `ABC-123` or a `/browse/ABC-123` URL. GitHub-form
 * refs (`#123`, `123`, github.com URLs) return null so a single shared
 * "parent issue" field can target whichever integration understands it.
 */
export function parseJiraParentIssueRef(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  const urlMatch = trimmed.match(BROWSE_URL_RE)
  if (urlMatch?.[1]) return urlMatch[1].toUpperCase()
  const keyMatch = trimmed.match(ISSUE_KEY_RE)
  if (keyMatch) return trimmed.toUpperCase()
  return null
}

export function isJiraParentIssueRef(raw: string): boolean {
  return parseJiraParentIssueRef(raw) !== null
}

/**
 * Create a Jira issue for the bug report (synchronous, fast).
 *
 * Mirrors createGitHubIssue: one Issues POST with no attachments so the
 * capture-submit response can carry the issue URL. Attachment uploads and
 * the description rewrite happen in attachAndUpdateJiraIssue, which the
 * caller fires in the background.
 *
 * Returns null when the report is missing, the org has no Jira integration,
 * or the Jira API call failed — all non-fatal for capture submission.
 */
export async function createJiraIssue(
  bugReportId: string,
  options?: {
    parentIssueRef?: string | null
    /** Reporter-chosen field values (already sanitised); beat admin defaults. */
    jiraFields?: Record<string, unknown>
  }
): Promise<CreatedJiraIssue | null> {
  try {
    const report = await loadReport(bugReportId)
    if (!report) {
      reportNonFatalError(
        `[jira-integration] Bug report ${bugReportId} not found for forwarding`,
        new Error("not_found")
      )
      return null
    }

    const credentials = await loadCredentials(report.organizationId)
    if (!credentials) return null

    const parentKey = resolveParentIssue({
      raw: options?.parentIssueRef,
      bugReportId,
    })
    const placement = parentKey
      ? await resolveParentPlacement({ credentials, parentKey, bugReportId })
      : null

    // Admin-configured extras go in first, then what the reporter picked in
    // the widget, then Crikket's own fields so those win on a clash — except
    // where the admin has deliberately pinned a value we'd otherwise guess
    // at (priority) or extend (labels).
    const extras = {
      ...credentials.extraFields,
      ...(options?.jiraFields ?? {}),
    }
    const baseFields: Record<string, unknown> = {
      ...extras,
      project: { key: credentials.projectKey },
      summary: renderSummary(report),
      description: renderDescription({ report, attachments: [] }),
      labels: mergeLabels(extras.labels, buildLabels(report.priority)),
    }
    const priority = mapPriority(report.priority)
    if (priority && !("priority" in extras)) {
      baseFields.priority = { name: priority }
    }

    const placed = await createWithPlacement({
      credentials,
      baseFields,
      parentKey,
      placement,
      bugReportId,
    })
    if (!placed) return null
    const created = placed.created
    let parentIssueKey = placed.parentIssueKey

    console.info(
      `[jira-integration] Created Jira issue ${created.key} for bug report ${bugReportId}: ${created.browseUrl}`
    )

    if (parentKey && !parentIssueKey) {
      // Couldn't nest (hierarchy, off-screen field, sub-task parent). Fall
      // back to an issue link so the relationship is visible on both sides.
      const linked = await linkToParent({
        credentials,
        childKey: created.key,
        parentKey,
        bugReportId,
      })
      if (linked) parentIssueKey = parentKey
    }

    return {
      key: created.key,
      browseUrl: created.browseUrl,
      credentials,
      parentIssueKey,
    }
  } catch (error) {
    reportNonFatalError(
      `[jira-integration] Unexpected failure creating Jira issue for ${bugReportId}`,
      error
    )
    return null
  }
}

/**
 * Upload bug-report artifacts as Jira attachments and rewrite the issue
 * description to reference them. Designed to run fire-and-forget after
 * createJiraIssue — failures are logged and never propagated.
 */
export async function attachAndUpdateJiraIssue(input: {
  bugReportId: string
  issueKey: string
  credentials: JiraIntegrationCredentials
}): Promise<void> {
  const { bugReportId, issueKey, credentials } = input
  try {
    const report = await loadReport(bugReportId)
    if (!report) return

    const attachments = await uploadAttachments({
      report,
      issueKey,
      credentials,
    })
    if (attachments.length === 0) return

    const description = renderDescription({ report, attachments })
    const response = await jiraFetch(
      credentials,
      `${JIRA_API_BASE}/issue/${encodeURIComponent(issueKey)}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fields: { description } }),
      }
    )
    if (!response.ok) {
      const text = await safeReadText(response)
      reportNonFatalError(
        `[jira-integration] Failed to update ${issueKey} with attachments (status ${response.status})`,
        new Error(text || response.statusText)
      )
    }
  } catch (error) {
    reportNonFatalError(
      `[jira-integration] Unexpected failure attaching artifacts for ${bugReportId}`,
      error
    )
  }
}

/** Create + attach in one call, for callers that don't need the URL early. */
export async function forwardBugReportToJira(
  bugReportId: string,
  options?: {
    parentIssueRef?: string | null
    jiraFields?: Record<string, unknown>
  }
): Promise<void> {
  const created = await createJiraIssue(bugReportId, options)
  if (!created) return
  await attachAndUpdateJiraIssue({
    bugReportId,
    issueKey: created.key,
    credentials: created.credentials,
  })
}

// ----- Jira API helpers ----------------------------------------------------

interface PostedIssue {
  key: string
  browseUrl: string
  sentFields: Set<string>
}

/**
 * The create ladder: a sub-task under a standard-level parent when that's
 * what the placement calls for, else the configured issue type (with the
 * parent attached for Epic-level parents). Returns the parent key only when
 * the issue actually nested under it.
 */
async function createWithPlacement(input: {
  credentials: JiraIntegrationCredentials
  baseFields: Record<string, unknown>
  parentKey: string | null
  placement: ParentPlacement | null
  bugReportId: string
}): Promise<{ created: PostedIssue; parentIssueKey: string | null } | null> {
  const { credentials, baseFields, parentKey, placement, bugReportId } = input

  // Standard-level parent (Story, Task): a Bug can't nest under it, but a
  // sub-task can. Try that first; any failure falls through to the
  // ordinary top-level create so the capture still lands somewhere.
  if (parentKey && placement?.mode === "subtask") {
    const created = await postIssueWithFieldFallback({
      credentials,
      fields: {
        ...baseFields,
        issuetype: { name: placement.issueType },
        parent: { key: parentKey },
      },
      bugReportId,
      keepParent: true,
    })
    if (created) {
      return { created, parentIssueKey: parentKey }
    }
    reportNonFatalError(
      `[jira-integration] Could not create a ${placement.issueType} under ${parentKey} for ${bugReportId}; falling back to a top-level ${credentials.issueType}`,
      new Error("subtask_create_failed")
    )
  }

  const fields: Record<string, unknown> = {
    ...baseFields,
    issuetype: { name: credentials.issueType },
  }
  if (parentKey && placement?.mode === "parent") {
    fields.parent = { key: parentKey }
  }
  const created = await postIssueWithFieldFallback({
    credentials,
    fields,
    bugReportId,
  })
  if (!created) return null
  return {
    created,
    parentIssueKey:
      parentKey && created.sentFields.has("parent") ? parentKey : null,
  }
}

async function postIssueWithFieldFallback(input: {
  credentials: JiraIntegrationCredentials
  fields: Record<string, unknown>
  bugReportId: string
  /** A sub-task without a parent is invalid, so never drop it on retry. */
  keepParent?: boolean
}): Promise<PostedIssue | null> {
  const { credentials, bugReportId } = input
  const fields = { ...input.fields }

  // At most two attempts: the full field set, then once more with whatever
  // optional fields Jira complained about removed.
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await jiraFetch(credentials, `${JIRA_API_BASE}/issue`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fields }),
    })

    if (response.ok) {
      const issue = (await response.json()) as { key?: string }
      if (typeof issue.key !== "string" || issue.key.length === 0) {
        reportNonFatalError(
          `[jira-integration] Jira issue response for ${bugReportId} missing key`,
          new Error("malformed_response")
        )
        return null
      }
      return {
        key: issue.key,
        browseUrl: browseUrlFor(credentials.siteUrl, issue.key),
        sentFields: new Set(Object.keys(fields)),
      }
    }

    const text = await safeReadText(response)
    const rejected =
      response.status === 400
        ? rejectedOptionalFields(text, fields).filter(
            (name) => !(input.keepParent && name === "parent")
          )
        : []
    if (attempt === 0 && rejected.length > 0) {
      for (const name of rejected) delete fields[name]
      reportNonFatalError(
        `[jira-integration] Jira rejected field(s) ${rejected.join(", ")} for ${bugReportId}; retrying without them`,
        new Error(text)
      )
      continue
    }

    reportNonFatalError(
      `[jira-integration] Failed to create Jira issue for ${bugReportId} (status ${response.status})`,
      new Error(text || response.statusText)
    )
    return null
  }
  return null
}

/**
 * Jira's 400 payload is `{ errorMessages: string[], errors: { field: msg } }`.
 * Return the fields we sent that Jira named in `errors` and that are safe to
 * drop: our own optional ones, plus any custom field (admin defaults and
 * reporter picks) — a create screen for a different issue type (sub-task)
 * often lacks fields the Bug screen has.
 */
function rejectedOptionalFields(
  responseText: string,
  fields: Record<string, unknown>
): string[] {
  let parsed: { errors?: Record<string, unknown> } | null = null
  try {
    parsed = JSON.parse(responseText) as { errors?: Record<string, unknown> }
  } catch {
    return []
  }
  const errors = parsed?.errors
  if (!errors || typeof errors !== "object") return []
  return Object.keys(fields).filter(
    (name) =>
      name in errors &&
      ((OPTIONAL_CREATE_FIELDS as readonly string[]).includes(name) ||
        name.startsWith("customfield_"))
  )
}

type ParentPlacement =
  | { mode: "parent" }
  | { mode: "subtask"; issueType: string }
  | { mode: "link" }

interface ParentIssueType {
  name: string
  subtask: boolean
  hierarchyLevel?: number
}

/**
 * Decide how to attach to the reporter's parent:
 *   - Epic (or higher) parent: set `parent` on the Bug as-is.
 *   - Standard-level parent (Story, Task, Bug): create as a sub-task type.
 *   - Sub-task parent, or lookup failure: plain Bug plus a Relates link.
 */
async function resolveParentPlacement(input: {
  credentials: JiraIntegrationCredentials
  parentKey: string
  bugReportId: string
}): Promise<ParentPlacement> {
  const { credentials, parentKey, bugReportId } = input
  const parentType = await fetchParentIssueType(credentials, parentKey)
  if (!parentType) {
    reportNonFatalError(
      `[jira-integration] Could not read parent ${parentKey} for ${bugReportId}; will link instead of nesting`,
      new Error("parent_lookup_failed")
    )
    return { mode: "link" }
  }
  if (parentType.subtask) {
    return { mode: "link" }
  }
  if (isEpicLevel(parentType)) {
    return { mode: "parent" }
  }
  const issueType =
    credentials.subtaskIssueType ??
    (await discoverSubtaskIssueType(credentials, bugReportId))
  if (!issueType) {
    // No sub-task type to use; the parent attempt will be rejected and the
    // link fallback kicks in.
    return { mode: "parent" }
  }
  return { mode: "subtask", issueType }
}

// Cloud reports hierarchyLevel (0 = standard, 1 = Epic, 2+ = above Epic).
// Data Center has no such field, so fall back to the type's name.
function isEpicLevel(type: ParentIssueType): boolean {
  if (typeof type.hierarchyLevel === "number") {
    return type.hierarchyLevel >= 1
  }
  return EPIC_NAME_RE.test(type.name)
}

async function fetchParentIssueType(
  credentials: JiraIntegrationCredentials,
  parentKey: string
): Promise<ParentIssueType | null> {
  try {
    const response = await jiraFetch(
      credentials,
      `${JIRA_API_BASE}/issue/${encodeURIComponent(parentKey)}?fields=issuetype`
    )
    if (!response.ok) return null
    const data = (await response.json()) as {
      fields?: {
        issuetype?: {
          name?: string
          subtask?: boolean
          hierarchyLevel?: number
        }
      }
    }
    const type = data.fields?.issuetype
    if (!type?.name) return null
    return {
      name: type.name,
      subtask: type.subtask === true,
      hierarchyLevel: type.hierarchyLevel,
    }
  } catch {
    return null
  }
}

const subtaskTypeCache = new Map<
  string,
  { expiresAt: number; name: string | null }
>()

/** First sub-task type the project offers; cached per site + project. */
async function discoverSubtaskIssueType(
  credentials: JiraIntegrationCredentials,
  bugReportId: string
): Promise<string | null> {
  const cacheKey = `${credentials.siteUrl}|${credentials.projectKey}`
  const cached = subtaskTypeCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) return cached.name
  try {
    const response = await jiraFetch(
      credentials,
      `${JIRA_API_BASE}/project/${encodeURIComponent(credentials.projectKey)}`
    )
    if (!response.ok) {
      throw new Error(`${response.status} ${await safeReadText(response)}`)
    }
    const data = (await response.json()) as {
      issueTypes?: Array<{ name?: string; subtask?: boolean }>
    }
    const name =
      data.issueTypes?.find((t) => t.subtask === true && t.name)?.name ?? null
    subtaskTypeCache.set(cacheKey, {
      expiresAt: Date.now() + SUBTASK_TYPE_CACHE_TTL_MS,
      name,
    })
    return name
  } catch (error) {
    reportNonFatalError(
      `[jira-integration] Could not discover a sub-task type for ${credentials.projectKey} (${bugReportId})`,
      error
    )
    return null
  }
}

/** Test seam. */
export function clearJiraSubtaskTypeCache(): void {
  subtaskTypeCache.clear()
}

async function linkToParent(input: {
  credentials: JiraIntegrationCredentials
  childKey: string
  parentKey: string
  bugReportId: string
}): Promise<boolean> {
  const { credentials, childKey, parentKey, bugReportId } = input
  try {
    const response = await jiraFetch(
      credentials,
      `${JIRA_API_BASE}/issueLink`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: { name: PARENT_LINK_TYPE },
          inwardIssue: { key: childKey },
          outwardIssue: { key: parentKey },
        }),
      }
    )
    if (!response.ok) {
      const text = await safeReadText(response)
      reportNonFatalError(
        `[jira-integration] Failed to link ${childKey} to parent ${parentKey} for ${bugReportId} (status ${response.status})`,
        new Error(text || response.statusText)
      )
      return false
    }
    console.info(
      `[jira-integration] Linked ${childKey} to parent ${parentKey} for bug report ${bugReportId}`
    )
    return true
  } catch (error) {
    reportNonFatalError(
      `[jira-integration] Unexpected failure linking ${childKey} to ${parentKey} for ${bugReportId}`,
      error
    )
    return false
  }
}

function resolveParentIssue(input: {
  raw: string | null | undefined
  bugReportId: string
}): string | null {
  const { raw, bugReportId } = input
  if (!raw?.trim()) return null
  const key = parseJiraParentIssueRef(raw)
  if (!key) {
    // Not a Jira-form ref. The shared parent field may hold a GitHub ref
    // instead, which the GitHub integration owns — nothing to report here.
    console.info(
      `[jira-integration] Parent ref for ${bugReportId} is not a Jira issue key; skipping parent link`
    )
    return null
  }
  return key
}

async function uploadAttachments(input: {
  report: ReportWithRelations
  issueKey: string
  credentials: JiraIntegrationCredentials
}): Promise<AttachmentResult[]> {
  const { report, issueKey, credentials } = input
  const storage = getStorageProvider()
  const results: AttachmentResult[] = []

  if (report.captureKey) {
    const captureKey = report.captureKey
    results.push(
      await uploadSingleAttachment({
        kind: "capture",
        label: report.attachmentType === "video" ? "Recording" : "Screenshot",
        filename: filenameForCapture(report),
        contentType:
          report.attachmentType === "video" ? "video/webm" : "image/png",
        readBytes: () => storage.read(captureKey),
        issueKey,
        credentials,
      })
    )
  }

  if (report.debuggerKey) {
    const debuggerKey = report.debuggerKey
    const isGzipped = report.debuggerContentEncoding === "gzip"
    results.push(
      await uploadSingleAttachment({
        kind: "debugger",
        label: "Debugger payload",
        filename: `${report.id}.debugger.json`,
        contentType: "application/json",
        readBytes: async () => {
          const raw = await storage.read(debuggerKey)
          return isGzipped ? Buffer.from(gunzipSync(raw)) : raw
        },
        issueKey,
        credentials,
      })
    )
  }

  return results
}

async function uploadSingleAttachment(opts: {
  kind: AttachmentKind
  label: string
  filename: string
  contentType: string
  readBytes: () => Promise<Buffer>
  issueKey: string
  credentials: JiraIntegrationCredentials
}): Promise<AttachmentResult> {
  const result: AttachmentResult = {
    kind: opts.kind,
    label: opts.label,
    filename: opts.filename,
  }
  try {
    const bytes = await opts.readBytes()
    if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
      result.tooLargeBytes = bytes.byteLength
      return result
    }
    const form = new FormData()
    form.append(
      "file",
      new Blob([new Uint8Array(bytes)], { type: opts.contentType }),
      opts.filename
    )
    const response = await jiraFetch(
      opts.credentials,
      `${JIRA_API_BASE}/issue/${encodeURIComponent(opts.issueKey)}/attachments`,
      {
        method: "POST",
        // Jira's XSRF check rejects multipart uploads without this header.
        headers: { "X-Atlassian-Token": "no-check" },
        body: form,
      }
    )
    if (!response.ok) {
      throw new Error(
        `upload ${opts.filename}: ${response.status} ${await safeReadText(response)}`
      )
    }
    result.attached = true
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error)
  }
  return result
}

function jiraFetch(
  credentials: JiraIntegrationCredentials,
  path: string,
  init: RequestInit = {}
): Promise<Response> {
  const { headers, ...rest } = init
  const basic = Buffer.from(
    `${credentials.email}:${credentials.apiToken}`
  ).toString("base64")
  return fetch(`${credentials.siteUrl}${path}`, {
    ...rest,
    headers: {
      Authorization: `Basic ${basic}`,
      Accept: "application/json",
      "User-Agent": "crikket-self-hosted",
      ...(headers ?? {}),
    },
  })
}

function browseUrlFor(siteUrl: string, key: string): string {
  return `${siteUrl}/browse/${encodeURIComponent(key)}`
}

function loadReport(
  bugReportId: string
): Promise<ReportWithRelations | undefined> {
  return db.query.bugReport.findFirst({
    where: eq(bugReport.id, bugReportId),
    with: {
      logs: {
        orderBy: (t, { asc: a }) => [a(t.timestamp)],
        limit: MAX_LOG_LINES,
      },
      networkRequests: {
        orderBy: (t, { asc: a }) => [a(t.timestamp)],
        limit: MAX_NETWORK_ROWS,
      },
      actions: {
        orderBy: (t, { asc: a }) => [a(t.timestamp)],
        limit: MAX_ACTION_ROWS,
      },
    },
  }) as Promise<ReportWithRelations | undefined>
}

function loadCredentials(
  organizationId: string
): Promise<JiraIntegrationCredentials | null> {
  return getJiraIntegrationCredentials(organizationId).catch((error) => {
    reportNonFatalError(
      `[jira-integration] Failed to load credentials for org ${organizationId}`,
      error
    )
    return null
  })
}

function filenameForCapture(report: ReportWithRelations): string {
  if (report.attachmentType === "video") {
    return `${report.id}.webm`
  }
  return `${report.id}.png`
}

// ----- Rendering (Jira wiki markup) ----------------------------------------

interface ReportWithRelations {
  id: string
  organizationId: string
  title: string | null
  description: string | null
  priority: string
  url: string | null
  status: string
  tags: string[] | null
  attachmentType: string | null
  deviceInfo: unknown
  metadata: unknown
  createdAt: Date
  captureKey: string | null
  debuggerKey: string | null
  debuggerContentEncoding: string | null
  logs: Array<{
    level: string
    message: string
    timestamp: Date
  }>
  networkRequests: Array<{
    method: string
    url: string
    status: number | null
    duration: number | null
    responseBody: string | null
    timestamp: Date
  }>
  actions: Array<{
    type: string
    target: string | null
    offset: number | null
    metadata: unknown
    timestamp: Date
  }>
}

function renderSummary(report: ReportWithRelations): string {
  const trimmed = report.title?.trim()
  let summary: string
  if (trimmed) {
    summary = `[crikket] ${trimmed}`
  } else if (report.url) {
    summary = `[crikket] Bug report from ${report.url}`
  } else {
    summary = `[crikket] Bug report ${report.id}`
  }
  // Jira rejects summaries containing newlines outright.
  return truncate(summary.replace(/\s*\n\s*/g, " "), MAX_SUMMARY_LEN)
}

function renderDescription(input: {
  report: ReportWithRelations
  attachments: AttachmentResult[]
}): string {
  const { report, attachments } = input
  const device = (report.deviceInfo ?? {}) as DeviceInfo
  const metadata = (report.metadata ?? {}) as ReportMetadata
  const sections: string[] = []

  sections.push(
    `{quote}Forwarded from Crikket bug report {{${report.id}}} on ${report.createdAt.toISOString()}{quote}`
  )

  if (report.description?.trim()) {
    sections.push("h2. Description", escapeBlock(report.description.trim()))
  }

  sections.push(
    "h2. Context",
    renderContextTable({
      URL: report.url ?? "—",
      Browser: device.browser ?? "—",
      OS: device.os ?? "—",
      Viewport: device.viewport ?? "—",
      Priority: report.priority,
      Tags: report.tags?.length ? report.tags.join(", ") : "—",
      Attachment: report.attachmentType ?? "—",
      Duration: metadata.duration ?? "—",
      "SDK version": metadata.sdkVersion ?? "—",
      "Submitted via": metadata.submittedVia ?? "—",
    })
  )

  const attachmentSection = renderAttachmentsSection(report, attachments)
  if (attachmentSection) {
    sections.push(attachmentSection)
  }

  if (report.actions.length > 0) {
    sections.push("h2. Reproduction steps", renderActionList(report.actions))
  }

  if (report.logs.length > 0) {
    // Single-newline joins inside the block: wiki markup renders blank
    // lines in {noformat} literally.
    sections.push(
      "h2. Console logs",
      [
        "{noformat}",
        ...report.logs.map(
          (log) =>
            `[${log.timestamp.toISOString()}] ${log.level.toUpperCase()}: ${truncate(log.message)}`
        ),
        "{noformat}",
      ].join("\n")
    )
  }

  if (report.networkRequests.length > 0) {
    sections.push(
      "h2. Network requests",
      renderNetworkTable(report.networkRequests)
    )
  }

  return truncate(sections.join("\n\n"), MAX_DESCRIPTION_LEN)
}

function renderAttachmentsSection(
  report: ReportWithRelations,
  attachments: AttachmentResult[]
): string | null {
  if (attachments.length === 0) return null

  const lines: string[] = ["h2. Artifacts"]
  for (const attachment of attachments) {
    if (attachment.attached) {
      // `[^file]` links the Jira attachment; `!file|thumbnail!` additionally
      // renders an inline preview, which only makes sense for images.
      const preview =
        attachment.kind === "capture" && report.attachmentType !== "video"
          ? `\n!${attachment.filename}|thumbnail!`
          : ""
      lines.push(
        `* *${attachment.label}* — [^${attachment.filename}]${preview}`
      )
    } else if (attachment.tooLargeBytes != null) {
      const mb = (attachment.tooLargeBytes / (1024 * 1024)).toFixed(1)
      lines.push(
        `* *${attachment.label}* — not uploaded (${mb} MB exceeds the ${
          MAX_ATTACHMENT_BYTES / (1024 * 1024)
        } MB per-file limit). Retrieve from crikket: report id {{${report.id}}}`
      )
    } else {
      lines.push(
        `* *${attachment.label}* — upload failed (${escapeInline(attachment.error ?? "unknown error")}). Retrieve from crikket: report id {{${report.id}}}`
      )
    }
  }
  return lines.join("\n")
}

function renderContextTable(rows: Record<string, string>): string {
  const lines = ["||Field||Value||"]
  for (const [key, value] of Object.entries(rows)) {
    lines.push(`|${key}|${escapeCell(value)}|`)
  }
  return lines.join("\n")
}

function renderNetworkTable(
  rows: Array<{
    method: string
    url: string
    status: number | null
    duration: number | null
    responseBody: string | null
  }>
): string {
  const lines = ["||Method||Status||Duration||URL||Response||"]
  for (const row of rows) {
    lines.push(
      `|${row.method}|${row.status ?? "—"}|${
        row.duration != null ? `${row.duration}ms` : "—"
      }|${escapeCell(truncate(row.url))}|${renderResponseSnippet(row.status, row.responseBody)}|`
    )
  }
  return lines.join("\n")
}

// Only surface the response body for error responses; a 200 payload adds
// noise without helping reproduce the bug.
function renderResponseSnippet(
  status: number | null,
  body: string | null
): string {
  if (status == null || status < 400) return "—"
  if (!body) return "—"
  const collapsed = body.replace(/\s+/g, " ").trim()
  if (collapsed.length === 0) return "—"
  return `{{${escapeCell(truncate(collapsed, 200))}}}`
}

function renderActionList(
  actions: Array<{
    type: string
    target: string | null
    offset: number | null
    metadata: unknown
  }>
): string {
  return actions
    .map((action) => {
      const description = describeAction(action)
      const offsetSuffix =
        action.offset != null ? ` _(${formatOffset(action.offset)})_` : ""
      const separator = description ? " — " : ""
      return `# *${action.type}*${separator}${description}${offsetSuffix}`
    })
    .join("\n")
}

function describeAction(action: {
  type: string
  target: string | null
  metadata: unknown
}): string {
  if (action.type === "navigation" && isRecord(action.metadata)) {
    const meta = action.metadata
    const path = typeof meta.path === "string" ? meta.path : undefined
    const url = typeof meta.url === "string" ? meta.url : undefined
    const mode = typeof meta.mode === "string" ? meta.mode : undefined
    const primary = path && path.length > 0 ? path : url
    if (primary) {
      const modeSuffix = mode ? ` _(${mode})_` : ""
      return `{{${escapeInline(truncate(primary, 120))}}}${modeSuffix}`
    }
  }
  if (action.target) {
    return `{{${escapeInline(truncate(action.target, 120))}}}`
  }
  return ""
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function formatOffset(offsetMs: number): string {
  if (!Number.isFinite(offsetMs) || offsetMs < 0) return ""
  if (offsetMs < 1000) return `+${Math.round(offsetMs)}ms`
  const secs = offsetMs / 1000
  return `+${secs >= 10 ? secs.toFixed(0) : secs.toFixed(1)}s`
}

// Jira labels can't contain whitespace, so use a dash rather than the
// `priority:high` form GitHub gets.
function buildLabels(priority: string): string[] {
  const labels = ["crikket"]
  if (priority && priority !== "none") {
    labels.push(`priority-${priority}`)
  }
  return labels
}

function mergeLabels(extra: unknown, own: string[]): string[] {
  const fromExtras = Array.isArray(extra)
    ? extra.filter((v): v is string => typeof v === "string")
    : []
  return [...new Set([...fromExtras, ...own])]
}

// Crikket priorities onto Jira's default priority scheme. Custom schemes
// that lack these names make Jira reject the field, which the create-retry
// handles by dropping it.
function mapPriority(priority: string): string | null {
  switch (priority) {
    case "critical":
      return "Highest"
    case "high":
      return "High"
    case "medium":
      return "Medium"
    case "low":
      return "Low"
    default:
      return null
  }
}

// Wiki markup has no reliable escape for `|` inside table cells, so swap it
// for a broken bar; `{`/`[` would otherwise open macros and links.
function escapeCell(value: string): string {
  return escapeInline(value).replace(/\|/g, "¦").replace(/\n/g, " ")
}

function escapeInline(value: string): string {
  return value.replace(/[{[]/g, "\\$&")
}

// Free text from the reporter: keep newlines, neutralize macro/link openers.
function escapeBlock(value: string): string {
  return escapeInline(value)
}

function truncate(value: string, max = MAX_MESSAGE_LEN): string {
  if (value.length <= max) return value
  return `${value.slice(0, max)}…`
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 500)
  } catch {
    return ""
  }
}
