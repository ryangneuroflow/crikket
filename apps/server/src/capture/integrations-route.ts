import { getGithubIntegrationSummary } from "@crikket/bug-reports/lib/github-integration-config"
import { getJiraReporterFields } from "@crikket/bug-reports/lib/jira-fields"
import { getJiraIntegrationSummary } from "@crikket/bug-reports/lib/jira-integration-config"
import {
  authorizeCaptureSubmitRequest,
  buildJsonResponse,
  toCaptureErrorResponse,
} from "./shared"

/**
 * Public-key authorized read of which trackers the org forwards to, so the
 * capture widget can offer a "Submit to" choice and render the fields the
 * chosen tracker needs. Nothing secret leaves: just configured flags and
 * Jira's create-screen field definitions.
 */
export async function handleCaptureIntegrations(input: {
  request: Request
}): Promise<Response> {
  const route = "/api/embed/integrations"
  let keyId: string | null = null
  let origin: string | null = null

  try {
    const authorization = await authorizeCaptureSubmitRequest({
      request: input.request,
      route,
    })
    if (authorization instanceof Response) {
      return authorization
    }

    keyId = authorization.keyId
    origin = authorization.origin

    const [github, jira] = await Promise.all([
      getGithubIntegrationSummary(authorization.organizationId),
      getJiraIntegrationSummary(authorization.organizationId),
    ])
    const fields = jira.configured
      ? await getJiraReporterFields(authorization.organizationId)
      : []

    return buildJsonResponse(
      {
        github: { configured: github.configured },
        jira: { configured: jira.configured, fields },
      },
      { headers: authorization.rateLimitHeaders }
    )
  } catch (error) {
    return toCaptureErrorResponse(error, {
      keyId,
      method: input.request.method,
      origin,
      route,
    })
  }
}
