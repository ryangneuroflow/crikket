import type {
  CaptureIntegrations,
  CaptureRuntimeConfig,
  JiraReporterField,
} from "../types"

const INTEGRATIONS_PATH = "/api/embed/integrations"
const VALID_TYPES = new Set(["select", "multiselect", "text", "number"])
const NONE: CaptureIntegrations = {
  github: { configured: false },
  jira: { configured: false, fields: [] },
}

/**
 * Ask the host server which trackers the org forwards to and which Jira
 * fields the reporter must fill in. Resolves to "nothing configured" on
 * any failure so the form simply omits the tracker section.
 */
export async function fetchCaptureIntegrations(
  config: CaptureRuntimeConfig
): Promise<CaptureIntegrations> {
  const response = await fetch(`${config.host}${INTEGRATIONS_PATH}`, {
    method: "GET",
    headers: { "x-crikket-public-key": config.key },
    credentials: "omit",
    mode: "cors",
  })
  if (!response.ok) {
    return NONE
  }
  const payload = (await response.json()) as {
    github?: { configured?: unknown }
    jira?: { configured?: unknown; fields?: unknown }
  }
  return {
    github: { configured: payload.github?.configured === true },
    jira: {
      configured: payload.jira?.configured === true,
      fields: Array.isArray(payload.jira?.fields)
        ? payload.jira.fields.filter(isReporterField)
        : [],
    },
  }
}

function isReporterField(value: unknown): value is JiraReporterField {
  if (typeof value !== "object" || value === null) return false
  const field = value as Record<string, unknown>
  return (
    typeof field.id === "string" &&
    typeof field.name === "string" &&
    typeof field.type === "string" &&
    VALID_TYPES.has(field.type)
  )
}
