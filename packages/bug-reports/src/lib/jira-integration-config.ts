import { db } from "@crikket/db"
import { organizationJiraIntegration } from "@crikket/db/schema/jira-integration"
import { env } from "@crikket/env/server"
import { decryptSecret, encryptSecret } from "@crikket/shared/lib/server/crypto"
import { eq } from "drizzle-orm"
import { nanoid } from "nanoid"

export const DEFAULT_JIRA_ISSUE_TYPE = "Bug"

export interface JiraIntegrationSummary {
  configured: boolean
  siteUrl: string | null
  email: string | null
  projectKey: string | null
  issueType: string | null
  subtaskIssueType: string | null
  extraFieldsJson: string | null
}

export interface JiraIntegrationCredentials {
  siteUrl: string
  email: string
  projectKey: string
  issueType: string
  /** Null = auto-discover the project's first sub-task type. */
  subtaskIssueType: string | null
  apiToken: string
  /** Parsed form of extra_fields_json; empty object when unset or unreadable. */
  extraFields: Record<string, unknown>
}

const MAX_EXTRA_FIELDS_JSON_LENGTH = 8000

const TRAILING_SLASHES_RE = /\/+$/

const EMPTY_SUMMARY: JiraIntegrationSummary = {
  configured: false,
  siteUrl: null,
  email: null,
  projectKey: null,
  issueType: null,
  subtaskIssueType: null,
  extraFieldsJson: null,
}

/**
 * Canonical form of a Jira site URL: origin + optional path prefix (for
 * Data Center installs served under a context path), no trailing slash.
 * Throws on anything that isn't an http(s) URL.
 */
export function normalizeJiraSiteUrl(raw: string): string {
  const parsed = new URL(raw.trim())
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("Jira site URL must use http or https.")
  }
  const path = parsed.pathname.replace(TRAILING_SLASHES_RE, "")
  return `${parsed.origin}${path}`
}

/**
 * Validate and canonicalise the admin-supplied extra fields. Returns null
 * for blank input. Throws when the text isn't a JSON object so the error
 * surfaces in the settings form instead of at forward time.
 */
export function normalizeExtraFieldsJson(
  raw: string | undefined
): string | null {
  const trimmed = raw?.trim() ?? ""
  if (!trimmed) return null
  if (trimmed.length > MAX_EXTRA_FIELDS_JSON_LENGTH) {
    throw new Error(
      `Additional fields JSON must be at most ${MAX_EXTRA_FIELDS_JSON_LENGTH} characters.`
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    throw new Error("Additional fields must be valid JSON.")
  }
  if (!isPlainObject(parsed)) {
    throw new Error(
      'Additional fields must be a JSON object, e.g. {"customfield_10001": {"id": "123"}}.'
    )
  }
  return JSON.stringify(parsed)
}

export function parseExtraFields(raw: string | null): Record<string, unknown> {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    return isPlainObject(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export async function getJiraIntegrationSummary(
  organizationId: string
): Promise<JiraIntegrationSummary> {
  const row = await db.query.organizationJiraIntegration.findFirst({
    where: eq(organizationJiraIntegration.organizationId, organizationId),
    columns: {
      siteUrl: true,
      email: true,
      projectKey: true,
      issueType: true,
      subtaskIssueType: true,
      extraFieldsJson: true,
    },
  })
  if (!row) return { ...EMPTY_SUMMARY }
  return {
    configured: true,
    siteUrl: row.siteUrl,
    email: row.email,
    projectKey: row.projectKey,
    issueType: row.issueType,
    subtaskIssueType: row.subtaskIssueType,
    extraFieldsJson: row.extraFieldsJson,
  }
}

export async function getJiraIntegrationCredentials(
  organizationId: string
): Promise<JiraIntegrationCredentials | null> {
  const row = await db.query.organizationJiraIntegration.findFirst({
    where: eq(organizationJiraIntegration.organizationId, organizationId),
    columns: {
      siteUrl: true,
      email: true,
      projectKey: true,
      issueType: true,
      subtaskIssueType: true,
      apiTokenEncrypted: true,
      extraFieldsJson: true,
    },
  })
  if (!row) return null
  try {
    const apiToken = decryptSecret(
      row.apiTokenEncrypted,
      env.BETTER_AUTH_SECRET
    )
    return {
      siteUrl: row.siteUrl,
      email: row.email,
      projectKey: row.projectKey,
      issueType: row.issueType,
      subtaskIssueType: row.subtaskIssueType,
      apiToken,
      extraFields: parseExtraFields(row.extraFieldsJson),
    }
  } catch {
    // Encrypted blob unreadable (corrupted row or key rotated). Treat as unconfigured.
    return null
  }
}

export async function upsertJiraIntegration(input: {
  organizationId: string
  siteUrl: string
  email: string
  projectKey: string
  issueType?: string
  /** Blank/undefined = auto-discover. */
  subtaskIssueType?: string
  /** If undefined, preserves the existing token. Required when no row exists yet. */
  apiToken?: string
  /** Blank/undefined clears any stored extra fields. */
  extraFieldsJson?: string
}): Promise<void> {
  const siteUrl = normalizeJiraSiteUrl(input.siteUrl)
  const extraFieldsJson = normalizeExtraFieldsJson(input.extraFieldsJson)
  const subtaskIssueType = input.subtaskIssueType?.trim() || null
  const issueType = input.issueType?.trim() || DEFAULT_JIRA_ISSUE_TYPE
  const projectKey = input.projectKey.trim().toUpperCase()
  const email = input.email.trim()

  const existing = await db.query.organizationJiraIntegration.findFirst({
    where: eq(organizationJiraIntegration.organizationId, input.organizationId),
    columns: { id: true, apiTokenEncrypted: true },
  })

  if (!existing) {
    if (!input.apiToken) {
      throw new Error("API token is required to create a Jira integration.")
    }
    await db.insert(organizationJiraIntegration).values({
      id: nanoid(16),
      organizationId: input.organizationId,
      siteUrl,
      email,
      projectKey,
      issueType,
      subtaskIssueType,
      apiTokenEncrypted: encryptSecret(input.apiToken, env.BETTER_AUTH_SECRET),
      extraFieldsJson,
    })
    return
  }

  const nextTokenEncrypted = input.apiToken
    ? encryptSecret(input.apiToken, env.BETTER_AUTH_SECRET)
    : existing.apiTokenEncrypted

  await db
    .update(organizationJiraIntegration)
    .set({
      siteUrl,
      email,
      projectKey,
      issueType,
      subtaskIssueType,
      apiTokenEncrypted: nextTokenEncrypted,
      extraFieldsJson,
      updatedAt: new Date(),
    })
    .where(eq(organizationJiraIntegration.id, existing.id))
}

export async function deleteJiraIntegration(
  organizationId: string
): Promise<void> {
  await db
    .delete(organizationJiraIntegration)
    .where(eq(organizationJiraIntegration.organizationId, organizationId))
}
