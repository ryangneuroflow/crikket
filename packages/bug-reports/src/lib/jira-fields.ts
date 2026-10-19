import { reportNonFatalError } from "@crikket/shared/lib/errors"
import {
  getJiraIntegrationCredentials,
  type JiraIntegrationCredentials,
} from "./jira-integration-config"

/**
 * Reporter-facing Jira fields: the subset of the project's create screen
 * that Crikket can't fill on its own and so exposes in the capture widget.
 *
 * A field is surfaced when it is required on the create screen (minus the
 * ones Crikket always sets) or when the admin pinned a default for it in
 * "Additional fields" — that second rule lets an admin opt an optional
 * field into the form by giving it a default.
 */
export interface JiraReporterField {
  id: string
  name: string
  required: boolean
  type: "select" | "multiselect" | "text" | "number"
  options?: Array<{ id: string; label: string }>
  /** Pre-selected value from the admin's extra fields, in submit shape. */
  defaultValue?: unknown
}

const JIRA_API_BASE = "/rest/api/2"
const CACHE_TTL_MS = 10 * 60 * 1000
const MAX_OPTIONS = 500
const MAX_TEXT_LENGTH = 1000
// Fields Crikket populates itself, or that make no sense for a reporter to
// pick from the widget.
const AUTO_FILLED_FIELDS = new Set([
  "project",
  "issuetype",
  "summary",
  "description",
  "reporter",
  "assignee",
  "labels",
  "priority",
  "parent",
  "attachment",
  "issuelinks",
  "security",
])

interface CreateMetaField {
  required?: boolean
  name?: string
  schema?: { type?: string; items?: string; custom?: string }
  allowedValues?: Array<{ id?: string; value?: string; name?: string }>
}

interface CacheEntry {
  expiresAt: number
  fingerprint: string
  fields: JiraReporterField[]
}

const cache = new Map<string, CacheEntry>()

/** Test seam: drop every cached createmeta response. */
export function clearJiraFieldsCache(): void {
  cache.clear()
}

/**
 * Fields the capture widget should render for this org. Empty when the org
 * has no Jira integration or Jira can't be reached (non-fatal: the admin's
 * defaults still apply at forward time).
 */
export async function getJiraReporterFields(
  organizationId: string
): Promise<JiraReporterField[]> {
  const credentials = await getJiraIntegrationCredentials(organizationId).catch(
    () => null
  )
  if (!credentials) return []

  const fingerprint = `${credentials.siteUrl}|${credentials.projectKey}|${credentials.issueType}|${JSON.stringify(credentials.extraFields)}`
  const cached = cache.get(organizationId)
  if (
    cached &&
    cached.fingerprint === fingerprint &&
    cached.expiresAt > Date.now()
  ) {
    return cached.fields
  }

  try {
    const fields = await fetchReporterFields(credentials)
    cache.set(organizationId, {
      expiresAt: Date.now() + CACHE_TTL_MS,
      fingerprint,
      fields,
    })
    return fields
  } catch (error) {
    reportNonFatalError(
      `[jira-integration] Failed to load create metadata for org ${organizationId}`,
      error
    )
    // Keep serving a stale entry over nothing: the widget still gets a form.
    return cached?.fields ?? []
  }
}

/**
 * Keep only the reporter-submitted values that match a surfaced field and
 * its allowed options/shape. Unknown keys and malformed values are dropped
 * rather than rejected so a stale widget never blocks a capture.
 */
export function sanitizeReporterJiraFields(
  fields: JiraReporterField[],
  submitted: Record<string, unknown> | undefined
): Record<string, unknown> {
  if (!submitted) return {}
  const result: Record<string, unknown> = {}
  for (const field of fields) {
    if (!(field.id in submitted)) continue
    const value = sanitizeValue(field, submitted[field.id])
    if (value !== undefined) result[field.id] = value
  }
  return result
}

function sanitizeValue(
  field: JiraReporterField,
  raw: unknown
): unknown | undefined {
  switch (field.type) {
    case "select": {
      const id = optionId(raw)
      return id && field.options?.some((o) => o.id === id) ? { id } : undefined
    }
    case "multiselect": {
      if (!Array.isArray(raw)) return undefined
      const ids = raw
        .map(optionId)
        .filter((id): id is string =>
          Boolean(id && field.options?.some((o) => o.id === id))
        )
      return ids.length > 0 ? ids.map((id) => ({ id })) : undefined
    }
    case "text": {
      if (typeof raw !== "string") return undefined
      const trimmed = raw.trim()
      return trimmed.length > 0 ? trimmed.slice(0, MAX_TEXT_LENGTH) : undefined
    }
    case "number": {
      const n = typeof raw === "string" ? Number(raw) : raw
      return typeof n === "number" && Number.isFinite(n) ? n : undefined
    }
    default:
      return undefined
  }
}

function optionId(raw: unknown): string | null {
  if (typeof raw === "string") return raw
  if (typeof raw === "object" && raw !== null && "id" in raw) {
    const id = (raw as { id: unknown }).id
    return typeof id === "string" ? id : null
  }
  return null
}

async function fetchReporterFields(
  credentials: JiraIntegrationCredentials
): Promise<JiraReporterField[]> {
  const query = new URLSearchParams({
    projectKeys: credentials.projectKey,
    issuetypeNames: credentials.issueType,
    expand: "projects.issuetypes.fields",
  })
  const basic = Buffer.from(
    `${credentials.email}:${credentials.apiToken}`
  ).toString("base64")
  const response = await fetch(
    `${credentials.siteUrl}${JIRA_API_BASE}/issue/createmeta?${query}`,
    {
      headers: {
        Authorization: `Basic ${basic}`,
        Accept: "application/json",
        "User-Agent": "crikket-self-hosted",
      },
    }
  )
  if (!response.ok) {
    throw new Error(`createmeta ${response.status}`)
  }
  const data = (await response.json()) as {
    projects?: Array<{
      issuetypes?: Array<{ fields?: Record<string, CreateMetaField> }>
    }>
  }
  const raw = data.projects?.[0]?.issuetypes?.[0]?.fields ?? {}
  return buildReporterFields(raw, credentials.extraFields)
}

/** Exported for tests: pure transform of createmeta fields. */
export function buildReporterFields(
  raw: Record<string, CreateMetaField>,
  extras: Record<string, unknown>
): JiraReporterField[] {
  const fields: JiraReporterField[] = []
  for (const [id, meta] of Object.entries(raw)) {
    if (AUTO_FILLED_FIELDS.has(id)) continue
    const pinned = id in extras
    if (!(meta.required || pinned)) continue
    const type = classify(meta)
    if (!type) continue

    const field: JiraReporterField = {
      id,
      name: meta.name ?? id,
      required: Boolean(meta.required),
      type,
    }
    if (type === "select" || type === "multiselect") {
      field.options = (meta.allowedValues ?? [])
        .slice(0, MAX_OPTIONS)
        .flatMap((v) =>
          v.id ? [{ id: String(v.id), label: v.value ?? v.name ?? v.id }] : []
        )
      if (field.options.length === 0) continue
    }
    const defaultValue = pinned
      ? sanitizeValue(field, extrasToSubmitShape(field, extras[id]))
      : undefined
    if (defaultValue !== undefined) field.defaultValue = defaultValue
    fields.push(field)
  }
  return fields
}

function classify(meta: CreateMetaField): JiraReporterField["type"] | null {
  const schema = meta.schema ?? {}
  const hasOptions = (meta.allowedValues?.length ?? 0) > 0
  if (schema.type === "option" && hasOptions) return "select"
  if (schema.type === "array" && schema.items === "option" && hasOptions) {
    return "multiselect"
  }
  if (schema.type === "string") return "text"
  if (schema.type === "number") return "number"
  // Users, versions, components, dates, cascading selects: not rendered.
  // The admin's extra-fields JSON still covers them at forward time.
  return null
}

// Admin extras may reference options by `{id}` or `{value}`; the widget
// speaks ids only, so resolve a `{value}` against the option labels.
function extrasToSubmitShape(field: JiraReporterField, raw: unknown): unknown {
  if (field.type === "select") {
    return resolveOption(field, raw)
  }
  if (field.type === "multiselect" && Array.isArray(raw)) {
    return raw.map((item) => resolveOption(field, item))
  }
  return raw
}

function resolveOption(field: JiraReporterField, raw: unknown): unknown {
  if (typeof raw === "object" && raw !== null && "value" in raw) {
    const value = (raw as { value: unknown }).value
    const match = field.options?.find((o) => o.label === value)
    return match ? { id: match.id } : raw
  }
  return raw
}
