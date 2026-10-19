import {
  getIntegration,
  removeIntegration,
  upsertIntegration,
} from "@crikket/bug-reports/procedures/jira-integration"

/**
 * Jira Integration Router
 * Per-organization config for forwarding bug reports to a Jira project.
 */
export const jiraIntegrationRouter = {
  get: getIntegration,
  upsert: upsertIntegration,
  remove: removeIntegration,
}
