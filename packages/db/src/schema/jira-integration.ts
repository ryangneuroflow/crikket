import { relations } from "drizzle-orm"
import {
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core"
import { organization } from "./auth"

export const organizationJiraIntegration = pgTable(
  "organization_jira_integration",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    // Base URL of the Jira site, e.g. https://acme.atlassian.net. Stored
    // without a trailing slash so REST paths can be appended directly.
    siteUrl: text("site_url").notNull(),
    // Atlassian account email paired with the API token (Basic auth).
    email: text("email").notNull(),
    projectKey: text("project_key").notNull(),
    issueType: text("issue_type").default("Bug").notNull(),
    // Issue type to use when the reporter's parent is a standard-level issue
    // (Story, Task...) that can't parent a Bug. Null = pick the project's
    // first sub-task type automatically.
    subtaskIssueType: text("subtask_issue_type"),
    apiTokenEncrypted: text("api_token_encrypted").notNull(),
    // JSON object merged into the create-issue `fields` payload. Lets admins
    // satisfy project-specific required fields (custom selects, components)
    // that Crikket can't know about. Null when none are configured.
    extraFieldsJson: text("extra_fields_json"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    index("org_jira_integration_organizationId_idx").on(table.organizationId),
    uniqueIndex("org_jira_integration_organizationId_unique").on(
      table.organizationId
    ),
  ]
)

export const organizationJiraIntegrationRelations = relations(
  organizationJiraIntegration,
  ({ one }) => ({
    organization: one(organization, {
      fields: [organizationJiraIntegration.organizationId],
      references: [organization.id],
    }),
  })
)
