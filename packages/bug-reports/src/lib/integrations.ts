import { gunzipSync } from "node:zlib"
import { db } from "@crikket/db"
import { bugReport } from "@crikket/db/schema/bug-report"
import { reportNonFatalError } from "@crikket/shared/lib/errors"
import { eq } from "drizzle-orm"
import { getGithubIntegrationCredentials } from "./github-integration-config"
import { getStorageProvider } from "./storage"

const MAX_LOG_LINES = 50
const MAX_NETWORK_ROWS = 50
const MAX_ACTION_ROWS = 50
const MAX_MESSAGE_LEN = 400
const GITHUB_API_VERSION = "2022-11-28"
// Every capture forwarded to GitHub is a bug report, so stamp the issue with
// the org's "Bug" issue type (GitHub's org-level Issue Types feature). GitHub
// matches on the type's display name and "silently drops it" when the token
// lacks push access or the org has no such type, so sending it never fails
// issue creation in repos/orgs that aren't configured for issue types.
const GITHUB_ISSUE_TYPE = "Bug"
const REPO_PATTERN = /^[^/\s]+\/[^/\s]+$/
const ATTACHMENTS_BRANCH = "crikket-attachments"
// GitHub's Contents API hard-caps at 100MB per file; 40MB leaves headroom for
// base64 overhead in the JSON request body and keeps issue load times sane.
const MAX_ATTACHMENT_BYTES = 40 * 1024 * 1024

// URL form: https://github.com/<owner>/<repo>/issues/<number>
// Tolerate http/https, www, trailing slashes, and a `?...`/`#...` tail.
const PARENT_ISSUE_URL_RE =
  /^https?:\/\/(?:www\.)?github\.com\/([^/\s]+)\/([^/\s]+)\/issues\/(\d+)(?:[/?#].*)?$/i
// Bare number or `#number` form.
const PARENT_ISSUE_NUMBER_RE = /^#?(\d+)$/

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
  url?: string
  /** Set when upload was skipped because of size. */
  tooLargeBytes?: number
  /** Set when upload failed for any other reason. */
  error?: string
}

export interface CreatedGitHubIssue {
  htmlUrl: string
  number: number
  /** GitHub's internal DB id of the created issue. Needed to attach it as a
   * sub-issue of a parent — the /sub_issues endpoint wants the child's id,
   * not its human-facing issue number. */
  id: number
  /** Repo + token captured for the follow-up attachment phase. */
  repo: string
  token: string
  /**
   * Non-null when a parent issue ref was supplied AND the sub-issue link
   * was established. Carries the resolved parent number so callers can
   * persist it alongside the child issue URL.
   */
  parentIssueNumber: number | null
}

/**
 * Parsed representation of the reporter-supplied parent-issue reference.
 *
 * We accept three input forms in the UI:
 *   - `123`
 *   - `#123`
 *   - `https://github.com/<owner>/<repo>/issues/123`
 *
 * When a full URL is supplied we remember the `owner/repo` so the integration
 * can verify it matches the org's configured target repo. A mismatch is a
 * non-fatal error — we skip the sub-issue attach and fall back to creating
 * a regular top-level issue so the capture still lands somewhere.
 */
export interface ParsedParentIssueRef {
  number: number
  /** Present only when the ref was a URL; null if the user typed just a number. */
  repo: string | null
}

/**
 * Turn the raw reporter input into a structured parent-issue reference.
 * Returns null for empty/whitespace input. Throws for malformed, non-empty
 * input so the caller can surface the problem instead of silently dropping
 * the reporter's intent.
 */
export function parseParentIssueRef(raw: string): ParsedParentIssueRef | null {
  const trimmed = raw.trim()
  if (!trimmed) return null

  const urlMatch = trimmed.match(PARENT_ISSUE_URL_RE)
  if (urlMatch) {
    const [, owner, repo, number] = urlMatch
    return { number: Number(number), repo: `${owner}/${repo}` }
  }

  const numMatch = trimmed.match(PARENT_ISSUE_NUMBER_RE)
  if (numMatch) {
    return { number: Number(numMatch[1]), repo: null }
  }

  throw new Error(
    `Parent issue must be a GitHub issue URL, #<number>, or <number> (got "${trimmed}")`
  )
}

/**
 * Create a GitHub issue for the bug report (synchronous, fast).
 *
 * Posts a single Issues API call without attachments — attachment uploads
 * touch GitHub's Contents API per file and run sequentially, which can take
 * seconds and would block the capture-submit response. The caller awaits this
 * to surface the issue URL in the success modal, then fires
 * attachAndUpdateGitHubIssue in the background to upload artifacts and PATCH
 * the issue body to embed the links.
 *
 * Returns null when:
 *   - the bug report is missing,
 *   - the org has no GitHub integration configured,
 *   - the integration is misconfigured (bad repo format), or
 *   - the GitHub API call itself failed.
 * All of these are treated as non-fatal — capture submission still succeeds.
 */
export async function createGitHubIssue(
  bugReportId: string,
  options?: { parentIssueRef?: string | null }
): Promise<CreatedGitHubIssue | null> {
  try {
    const report = await loadReport(bugReportId)
    if (!report) {
      reportNonFatalError(
        `[github-integration] Bug report ${bugReportId} not found for forwarding`,
        new Error("not_found")
      )
      return null
    }

    const credentials = await loadCredentials(report.organizationId)
    if (!credentials) return null
    const { repo, token } = credentials

    // Resolve the parent ref *before* creating the issue so a malformed ref
    // or a mismatched repo fails loudly (via reportNonFatalError) rather than
    // silently orphaning the new issue. We still create the issue either way
    // — the reporter's capture is the primary artifact, the sub-issue link
    // is a best-effort enhancement.
    const parent = resolveParentIssue({
      raw: options?.parentIssueRef,
      configuredRepo: repo,
      bugReportId,
    })

    const body = renderIssueBody({ report, attachments: [] })
    const title = renderIssueTitle(report)
    const labels = buildLabels(report.priority)

    const response = await ghFetch(
      `https://api.github.com/repos/${repo}/issues`,
      {
        token,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, body, labels, type: GITHUB_ISSUE_TYPE }),
      }
    )

    if (!response.ok) {
      const text = await safeReadText(response)
      reportNonFatalError(
        `[github-integration] Failed to create GitHub issue for ${bugReportId} (status ${response.status})`,
        new Error(text || response.statusText)
      )
      return null
    }

    const issue = (await response.json()) as {
      html_url?: string
      number?: number
      id?: number
    }
    if (
      !issue.html_url ||
      typeof issue.number !== "number" ||
      typeof issue.id !== "number"
    ) {
      reportNonFatalError(
        `[github-integration] GitHub issue response for ${bugReportId} missing html_url/number/id`,
        new Error("malformed_response")
      )
      return null
    }
    console.info(
      `[github-integration] Created GitHub issue #${issue.number} for bug report ${bugReportId}: ${issue.html_url}`
    )

    let parentIssueNumber: number | null = null
    if (parent) {
      const attached = await attachAsSubIssue({
        repo,
        token,
        parentNumber: parent.number,
        childIssueId: issue.id,
        bugReportId,
      })
      if (attached) {
        parentIssueNumber = parent.number
      }
    }

    return {
      htmlUrl: issue.html_url,
      number: issue.number,
      id: issue.id,
      repo,
      token,
      parentIssueNumber,
    }
  } catch (error) {
    reportNonFatalError(
      `[github-integration] Unexpected failure creating GitHub issue for ${bugReportId}`,
      error
    )
    return null
  }
}

/**
 * Attach a just-created issue as a sub-issue of the given parent via
 * GitHub's Sub-issues REST endpoint. Returns true on success, false on any
 * failure (all failures are non-fatal — the child issue already exists).
 */
async function attachAsSubIssue(input: {
  repo: string
  token: string
  parentNumber: number
  childIssueId: number
  bugReportId: string
}): Promise<boolean> {
  const { repo, token, parentNumber, childIssueId, bugReportId } = input
  try {
    const response = await ghFetch(
      `https://api.github.com/repos/${repo}/issues/${parentNumber}/sub_issues`,
      {
        token,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sub_issue_id: childIssueId }),
      }
    )
    if (!response.ok) {
      const text = await safeReadText(response)
      reportNonFatalError(
        `[github-integration] Failed to attach sub-issue to #${parentNumber} for ${bugReportId} (status ${response.status})`,
        new Error(text || response.statusText)
      )
      return false
    }
    console.info(
      `[github-integration] Linked bug report ${bugReportId} as sub-issue of #${parentNumber} on ${repo}`
    )
    return true
  } catch (error) {
    reportNonFatalError(
      `[github-integration] Unexpected failure attaching sub-issue to #${parentNumber} for ${bugReportId}`,
      error
    )
    return false
  }
}

/**
 * Parse the reporter-supplied parent ref and verify it targets the configured
 * repo. Returns null when the reporter didn't supply one, when the ref is
 * malformed, or when the URL points at a different repo than the integration
 * — each case is reported as non-fatal and the caller falls back to creating
 * a top-level issue.
 */
function resolveParentIssue(input: {
  raw: string | null | undefined
  configuredRepo: string
  bugReportId: string
}): ParsedParentIssueRef | null {
  const { raw, configuredRepo, bugReportId } = input
  if (!raw) return null

  let parsed: ParsedParentIssueRef | null
  try {
    parsed = parseParentIssueRef(raw)
  } catch (error) {
    reportNonFatalError(
      `[github-integration] Ignoring malformed parent-issue ref for ${bugReportId}`,
      error
    )
    return null
  }
  if (!parsed) return null

  if (
    parsed.repo &&
    parsed.repo.toLowerCase() !== configuredRepo.toLowerCase()
  ) {
    reportNonFatalError(
      `[github-integration] Parent issue repo "${parsed.repo}" does not match integration repo "${configuredRepo}" for ${bugReportId} — skipping sub-issue link`,
      new Error("parent_repo_mismatch")
    )
    return null
  }
  return parsed
}

/**
 * Upload bug-report attachments to the configured repo and PATCH the issue
 * body to embed the resulting links. Designed to run fire-and-forget after
 * createGitHubIssue — failures are logged and never propagated.
 *
 * The repo + token are passed in (rather than re-loaded) so the credentials
 * fetched during issue creation are reused, avoiding a second decrypt round-
 * trip and a race where the integration is rotated mid-flow.
 */
export async function attachAndUpdateGitHubIssue(input: {
  bugReportId: string
  issueNumber: number
  repo: string
  token: string
}): Promise<void> {
  const { bugReportId, issueNumber, repo, token } = input
  try {
    const report = await loadReport(bugReportId)
    if (!report) return

    const attachments = await uploadAttachments({ report, repo, token })
    if (attachments.length === 0) return

    const body = renderIssueBody({ report, attachments })

    const response = await ghFetch(
      `https://api.github.com/repos/${repo}/issues/${issueNumber}`,
      {
        token,
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      }
    )

    if (!response.ok) {
      const text = await safeReadText(response)
      reportNonFatalError(
        `[github-integration] Failed to PATCH issue #${issueNumber} with attachments (status ${response.status})`,
        new Error(text || response.statusText)
      )
    }
  } catch (error) {
    reportNonFatalError(
      `[github-integration] Unexpected failure attaching artifacts for ${bugReportId}`,
      error
    )
  }
}

/**
 * Back-compat orchestrator: create + attach in one call. Existing callers
 * (and the original test suite) keep working; new callers (upload-session)
 * use createGitHubIssue + attachAndUpdateGitHubIssue separately so the
 * issue URL is available synchronously.
 */
export async function forwardBugReportToGitHub(
  bugReportId: string,
  options?: { parentIssueRef?: string | null }
): Promise<void> {
  const created = await createGitHubIssue(bugReportId, options)
  if (!created) return
  await attachAndUpdateGitHubIssue({
    bugReportId,
    issueNumber: created.number,
    repo: created.repo,
    token: created.token,
  })
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

async function loadCredentials(
  organizationId: string
): Promise<{ repo: string; token: string } | null> {
  const credentials = await getGithubIntegrationCredentials(
    organizationId
  ).catch((error) => {
    reportNonFatalError(
      `[github-integration] Failed to load credentials for org ${organizationId}`,
      error
    )
    return null
  })
  if (!credentials) return null
  if (!REPO_PATTERN.test(credentials.repo)) {
    reportNonFatalError(
      `[github-integration] GitHub repo must be "owner/repo"; got "${credentials.repo}"`,
      new Error("invalid_repo"),
      { once: true }
    )
    return null
  }
  return credentials
}

async function uploadAttachments(input: {
  report: ReportWithRelations
  repo: string
  token: string
}): Promise<AttachmentResult[]> {
  const { report, repo, token } = input
  const storage = getStorageProvider()
  const results: AttachmentResult[] = []
  let branchEnsured = false

  const ensureBranch = async (): Promise<boolean> => {
    if (branchEnsured) return true
    try {
      await ensureAttachmentsBranch({ repo, token, branch: ATTACHMENTS_BRANCH })
      branchEnsured = true
      return true
    } catch (error) {
      reportNonFatalError(
        `[github-integration] Could not ensure ${ATTACHMENTS_BRANCH} branch on ${repo}`,
        error
      )
      return false
    }
  }

  if (report.captureKey) {
    const captureKey = report.captureKey
    const captureFilename = filenameForCapture(report)
    results.push(
      await uploadSingleAttachment({
        kind: "capture",
        label: report.attachmentType === "video" ? "Recording" : "Screenshot",
        filename: captureFilename,
        readBytes: () => storage.read(captureKey),
        repo,
        token,
        reportId: report.id,
        commitMessage: `crikket: capture for bug report ${report.id}`,
        ensureBranch,
      })
    )
  }

  if (report.debuggerKey) {
    const debuggerKey = report.debuggerKey
    const debuggerFilename = `${report.id}.debugger.json`
    const isGzipped = report.debuggerContentEncoding === "gzip"
    results.push(
      await uploadSingleAttachment({
        kind: "debugger",
        label: "Debugger payload",
        filename: debuggerFilename,
        readBytes: async () => {
          const raw = await storage.read(debuggerKey)
          return isGzipped ? Buffer.from(gunzipSync(raw)) : raw
        },
        repo,
        token,
        reportId: report.id,
        commitMessage: `crikket: debugger payload for bug report ${report.id}`,
        ensureBranch,
      })
    )
  }

  return results
}

async function uploadSingleAttachment(opts: {
  kind: AttachmentKind
  label: string
  filename: string
  readBytes: () => Promise<Buffer>
  repo: string
  token: string
  reportId: string
  commitMessage: string
  ensureBranch: () => Promise<boolean>
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
    } else if (await opts.ensureBranch()) {
      result.url = await uploadArtifact({
        repo: opts.repo,
        token: opts.token,
        branch: ATTACHMENTS_BRANCH,
        path: `${opts.reportId}/${opts.filename}`,
        content: bytes,
        message: opts.commitMessage,
      })
    } else {
      result.error = "branch setup failed"
    }
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error)
  }
  return result
}

async function ensureAttachmentsBranch(input: {
  repo: string
  token: string
  branch: string
}): Promise<void> {
  const check = await ghFetch(
    `https://api.github.com/repos/${input.repo}/branches/${encodeURIComponent(input.branch)}`,
    { token: input.token }
  )
  if (check.ok) return
  if (check.status !== 404) {
    throw new Error(
      `check ${input.branch}: ${check.status} ${await safeReadText(check)}`
    )
  }

  const repoInfoResp = await ghFetch(
    `https://api.github.com/repos/${input.repo}`,
    { token: input.token }
  )
  if (!repoInfoResp.ok) {
    throw new Error(
      `fetch repo: ${repoInfoResp.status} ${await safeReadText(repoInfoResp)}`
    )
  }
  const repoInfo = (await repoInfoResp.json()) as { default_branch: string }

  const refResp = await ghFetch(
    `https://api.github.com/repos/${input.repo}/git/ref/heads/${encodeURIComponent(repoInfo.default_branch)}`,
    { token: input.token }
  )
  if (!refResp.ok) {
    throw new Error(
      `fetch default ref: ${refResp.status} ${await safeReadText(refResp)}`
    )
  }
  const refData = (await refResp.json()) as { object: { sha: string } }

  const createResp = await ghFetch(
    `https://api.github.com/repos/${input.repo}/git/refs`,
    {
      token: input.token,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ref: `refs/heads/${input.branch}`,
        sha: refData.object.sha,
      }),
    }
  )
  // 422 = already exists (race condition between check and create)
  if (!createResp.ok && createResp.status !== 422) {
    throw new Error(
      `create ref: ${createResp.status} ${await safeReadText(createResp)}`
    )
  }
}

async function uploadArtifact(input: {
  repo: string
  token: string
  branch: string
  path: string
  content: Buffer
  message: string
}): Promise<string> {
  const contentsUrl = `https://api.github.com/repos/${input.repo}/contents/${encodePath(input.path)}`

  // If the file already exists on the branch we need its sha for an overwrite.
  const existing = await ghFetch(
    `${contentsUrl}?ref=${encodeURIComponent(input.branch)}`,
    { token: input.token }
  )
  const existingSha = existing.ok
    ? ((await existing.json()) as { sha?: string }).sha
    : undefined

  const put = await ghFetch(contentsUrl, {
    token: input.token,
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: input.message,
      content: input.content.toString("base64"),
      branch: input.branch,
      sha: existingSha,
    }),
  })
  if (!put.ok) {
    throw new Error(
      `upload ${input.path}: ${put.status} ${await safeReadText(put)}`
    )
  }

  // Use the github.com/<repo>/blob URL rather than raw.githubusercontent.com.
  // raw.githubusercontent.com 404s for private repos without a bearer token,
  // so a plain browser click on a raw URL fails even for authorized viewers.
  // The /blob URL goes through GitHub's auth flow and works for any repo member.
  return `https://github.com/${input.repo}/blob/${encodeURIComponent(input.branch)}/${encodePath(input.path)}`
}

function ghFetch(
  url: string,
  init: RequestInit & { token: string }
): Promise<Response> {
  const { token, headers, ...rest } = init
  return fetch(url, {
    ...rest,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
      "User-Agent": "crikket-self-hosted",
      ...(headers ?? {}),
    },
  })
}

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/")
}

function filenameForCapture(report: ReportWithRelations): string {
  if (report.attachmentType === "video") {
    return `${report.id}.webm`
  }
  // Default to png for screenshots (matches crikket SDK default content type).
  return `${report.id}.png`
}

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

function renderIssueTitle(report: ReportWithRelations): string {
  const trimmed = report.title?.trim()
  if (trimmed) {
    return `[crikket] ${trimmed}`
  }
  if (report.url) {
    return `[crikket] Bug report from ${report.url}`
  }
  return `[crikket] Bug report ${report.id}`
}

function renderIssueBody(input: {
  report: ReportWithRelations
  attachments: AttachmentResult[]
}): string {
  const { report, attachments } = input
  const device = (report.deviceInfo ?? {}) as DeviceInfo
  const metadata = (report.metadata ?? {}) as ReportMetadata
  const sections: string[] = []

  sections.push(
    `> Forwarded from Crikket bug report \`${report.id}\` on ${report.createdAt.toISOString()}`
  )

  if (report.description?.trim()) {
    sections.push("## Description", report.description.trim())
  }

  sections.push(
    "## Context",
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
    sections.push("## Reproduction steps", renderActionList(report.actions))
  }

  if (report.logs.length > 0) {
    sections.push(
      "## Console logs",
      "```",
      report.logs
        .map(
          (log) =>
            `[${log.timestamp.toISOString()}] ${log.level.toUpperCase()}: ${truncate(log.message)}`
        )
        .join("\n"),
      "```"
    )
  }

  if (report.networkRequests.length > 0) {
    sections.push(
      "<details><summary>Network requests</summary>",
      "",
      renderNetworkTable(report.networkRequests),
      "",
      "</details>"
    )
  }

  return sections.join("\n\n")
}

function renderAttachmentsSection(
  report: ReportWithRelations,
  attachments: AttachmentResult[]
): string | null {
  if (attachments.length === 0) return null

  const lines: string[] = ["## Artifacts"]
  for (const attachment of attachments) {
    if (attachment.url) {
      // No inline ![](...) embed: GitHub's Camo image proxy refuses to fetch
      // private-repo content, so an embed would render as a broken image icon.
      // The link below opens the file via GitHub's authed blob viewer.
      lines.push(
        `- **${attachment.label}** — [${attachment.filename}](${attachment.url})`
      )
    } else if (attachment.tooLargeBytes != null) {
      const mb = (attachment.tooLargeBytes / (1024 * 1024)).toFixed(1)
      lines.push(
        `- **${attachment.label}** — not uploaded (${mb} MB exceeds the ${
          MAX_ATTACHMENT_BYTES / (1024 * 1024)
        } MB per-file limit). Retrieve from crikket: report id \`${report.id}\``
      )
    } else {
      lines.push(
        `- **${attachment.label}** — upload failed (${attachment.error ?? "unknown error"}). Retrieve from crikket: report id \`${report.id}\``
      )
    }
  }
  return lines.join("\n")
}

function renderContextTable(rows: Record<string, string>): string {
  const lines = ["| Field | Value |", "| --- | --- |"]
  for (const [key, value] of Object.entries(rows)) {
    lines.push(`| ${key} | ${escapeCell(value)} |`)
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
  const lines = [
    "| Method | Status | Duration | URL | Response |",
    "| --- | --- | --- | --- | --- |",
  ]
  for (const row of rows) {
    lines.push(
      `| ${row.method} | ${row.status ?? "—"} | ${
        row.duration != null ? `${row.duration}ms` : "—"
      } | ${escapeCell(truncate(row.url))} | ${renderResponseSnippet(row.status, row.responseBody)} |`
    )
  }
  return lines.join("\n")
}

// Only surface the response body for error responses; a 200 payload adds
// noise without helping reproduce the bug. The snippet is truncated and
// whitespace-collapsed to fit in a single table cell.
function renderResponseSnippet(
  status: number | null,
  body: string | null
): string {
  if (status == null || status < 400) return "—"
  if (!body) return "—"
  const collapsed = body.replace(/\s+/g, " ").trim()
  if (collapsed.length === 0) return "—"
  return `\`${escapeCell(truncate(collapsed, 200))}\``
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
    .map((action, idx) => {
      const description = describeAction(action)
      const offsetSuffix =
        action.offset != null ? ` _(${formatOffset(action.offset)})_` : ""
      const separator = description ? " — " : ""
      return `${idx + 1}. **${action.type}**${separator}${description}${offsetSuffix}`
    })
    .join("\n")
}

// Prefer navigation metadata (path + mode) over the generic "window" target
// the SDK emits for navigations — `/auth/register (pushState)` tells you
// what actually happened; `window` does not.
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
      return `\`${truncate(primary, 120)}\`${modeSuffix}`
    }
  }
  if (action.target) {
    return `\`${truncate(action.target, 120)}\``
  }
  return ""
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

// Offsets are milliseconds from the start of the recording. Render as ms
// under 1s and as seconds (1 decimal under 10s, integer above) otherwise —
// the goal is a glanceable `+2.1s` that lets a reader correlate steps with
// console logs and network rows without doing arithmetic on timestamps.
function formatOffset(offsetMs: number): string {
  if (!Number.isFinite(offsetMs) || offsetMs < 0) return ""
  if (offsetMs < 1000) return `+${Math.round(offsetMs)}ms`
  const secs = offsetMs / 1000
  return `+${secs >= 10 ? secs.toFixed(0) : secs.toFixed(1)}s`
}

function buildLabels(priority: string): string[] {
  const labels = ["crikket"]
  if (priority && priority !== "none") {
    labels.push(`priority:${priority}`)
  }
  return labels
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ")
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
