import { ORPCError } from "@orpc/server"
import { z } from "zod"
import {
  deleteJiraIntegration,
  getJiraIntegrationSummary,
  upsertJiraIntegration,
} from "../lib/jira-integration-config"
import { protectedProcedure } from "./context"
import { requireActiveOrgAdmin } from "./helpers"

const upsertInputSchema = z.object({
  siteUrl: z.url({ message: "Expected a Jira site URL" }),
  email: z.email({ message: "Expected an email address" }),
  projectKey: z
    .string()
    .trim()
    .regex(/^[A-Za-z][A-Za-z0-9_]*$/, { message: "Expected a project key" }),
  issueType: z.string().trim().max(80).optional(),
  subtaskIssueType: z.string().trim().max(80).optional(),
  // Empty string = "don't change the stored token". Non-empty = replace.
  apiToken: z.string().optional(),
  // JSON object merged into the create-issue payload; validated server-side.
  extraFieldsJson: z.string().max(8000).optional(),
})

export const getIntegration = protectedProcedure.handler(
  async ({ context }) => {
    const organizationId = await requireActiveOrgAdmin(context.session)
    return getJiraIntegrationSummary(organizationId)
  }
)

export const upsertIntegration = protectedProcedure
  .input(upsertInputSchema)
  .handler(async ({ context, input }) => {
    const organizationId = await requireActiveOrgAdmin(context.session)
    const trimmedToken =
      input.apiToken && input.apiToken.trim().length > 0
        ? input.apiToken.trim()
        : undefined

    try {
      await upsertJiraIntegration({
        organizationId,
        siteUrl: input.siteUrl,
        email: input.email,
        projectKey: input.projectKey,
        issueType: input.issueType,
        subtaskIssueType: input.subtaskIssueType,
        apiToken: trimmedToken,
        extraFieldsJson: input.extraFieldsJson,
      })
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Failed to save Jira integration."
      throw new ORPCError("BAD_REQUEST", { message })
    }

    return getJiraIntegrationSummary(organizationId)
  })

export const removeIntegration = protectedProcedure.handler(
  async ({ context }) => {
    const organizationId = await requireActiveOrgAdmin(context.session)
    await deleteJiraIntegration(organizationId)
    return { ok: true }
  }
)
