import { db } from "@crikket/db"
import { organization } from "@crikket/db/schema/auth"
import { capturePublicKey } from "@crikket/db/schema/bug-report"
import { eq } from "drizzle-orm"
import { normalizeCaptureOrigins } from "./capture-public-key"
import { upsertGithubIntegration } from "./github-integration-config"
import { upsertJiraIntegration } from "./jira-integration-config"

// Consumed by ephemeral environments (e.g. .github/workflows/ephemeral-env.yml)
// that must spin up Crikket and have issues flow to GitHub and/or Jira without
// any manual UI configuration. No-op when the required env vars are absent, so
// local dev through the UI continues to work.
//
// Idempotent: on every boot it (a) ensures a deterministic org exists,
// (b) refreshes the capture_public_key row's allowed origins (ephemeral tunnel
// URLs change per run), and (c) upserts whichever integration rows have env
// vars set. Never creates duplicate orgs or keys.
export async function runEphemeralBootstrap(): Promise<void> {
  const repo = process.env.GITHUB_BOOTSTRAP_REPO?.trim()
  const token = process.env.GITHUB_BOOTSTRAP_TOKEN?.trim()
  const jira = readJiraBootstrapEnv()
  const publicKeyValue = process.env.CAPTURE_BOOTSTRAP_PUBLIC_KEY?.trim()
  const originsRaw = process.env.CAPTURE_BOOTSTRAP_ORIGINS?.trim()

  const github = repo && token ? { repo, token } : null
  if (!((github || jira) && publicKeyValue && originsRaw)) {
    return
  }

  const allowedOrigins = normalizeCaptureOrigins(
    originsRaw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
  )

  if (allowedOrigins.length === 0) {
    console.warn(
      "[bootstrap] CAPTURE_BOOTSTRAP_ORIGINS yielded no valid http(s) origins — skipping."
    )
    return
  }

  const orgSlug = process.env.BOOTSTRAP_ORG_SLUG?.trim() || "ephemeral-default"
  const orgName = process.env.BOOTSTRAP_ORG_NAME?.trim() || "Ephemeral Default"
  const deterministicOrgId = `org_${orgSlug}`
  const deterministicKeyId = `cpk_${orgSlug}`

  const existingOrg = await db.query.organization.findFirst({
    where: eq(organization.slug, orgSlug),
    columns: { id: true },
  })
  const organizationId = existingOrg?.id ?? deterministicOrgId

  if (!existingOrg) {
    await db.insert(organization).values({
      id: deterministicOrgId,
      name: orgName,
      slug: orgSlug,
      createdAt: new Date(),
    })
    console.log(`[bootstrap] created organization ${orgSlug}`)
  }

  const existingKey = await db.query.capturePublicKey.findFirst({
    where: eq(capturePublicKey.key, publicKeyValue),
    columns: { id: true },
  })

  if (existingKey) {
    await db
      .update(capturePublicKey)
      .set({
        allowedOrigins,
        revokedAt: null,
        status: "active",
      })
      .where(eq(capturePublicKey.id, existingKey.id))
    console.log(
      `[bootstrap] refreshed capture public key origins: ${allowedOrigins.join(", ")}`
    )
  } else {
    await db.insert(capturePublicKey).values({
      allowedOrigins,
      createdBy: null,
      id: deterministicKeyId,
      key: publicKeyValue,
      label: orgName,
      organizationId,
      status: "active",
    })
    console.log(`[bootstrap] created capture public key for ${orgSlug}`)
  }

  if (github) {
    await upsertGithubIntegration({ organizationId, ...github })
    console.log(`[bootstrap] GitHub integration configured for ${github.repo}`)
  }

  if (jira) {
    await upsertJiraIntegration({ organizationId, ...jira })
    console.log(
      `[bootstrap] Jira integration configured for ${jira.projectKey} on ${jira.siteUrl}`
    )
  }
}

function readJiraBootstrapEnv(): {
  siteUrl: string
  email: string
  projectKey: string
  issueType?: string
  subtaskIssueType?: string
  apiToken: string
  extraFieldsJson?: string
} | null {
  const siteUrl = process.env.JIRA_BOOTSTRAP_SITE_URL?.trim()
  const email = process.env.JIRA_BOOTSTRAP_EMAIL?.trim()
  const projectKey = process.env.JIRA_BOOTSTRAP_PROJECT_KEY?.trim()
  const apiToken = process.env.JIRA_BOOTSTRAP_API_TOKEN?.trim()
  const issueType = process.env.JIRA_BOOTSTRAP_ISSUE_TYPE?.trim()
  const extraFieldsJson = process.env.JIRA_BOOTSTRAP_EXTRA_FIELDS_JSON?.trim()
  const subtaskIssueType = process.env.JIRA_BOOTSTRAP_SUBTASK_ISSUE_TYPE?.trim()
  if (!(siteUrl && email && projectKey && apiToken)) return null
  return {
    siteUrl,
    email,
    projectKey,
    apiToken,
    issueType: issueType || undefined,
    subtaskIssueType: subtaskIssueType || undefined,
    extraFieldsJson: extraFieldsJson || undefined,
  }
}
