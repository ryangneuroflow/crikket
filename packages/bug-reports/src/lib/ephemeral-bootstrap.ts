import { db } from "@crikket/db"
import { organization } from "@crikket/db/schema/auth"
import { capturePublicKey } from "@crikket/db/schema/bug-report"
import { eq } from "drizzle-orm"
import { normalizeCaptureOrigins } from "./capture-public-key"
import { upsertGithubIntegration } from "./github-integration-config"

// Consumed by ephemeral environments (e.g. .github/workflows/ephemeral-env.yml)
// that must spin up Crikket and have issues flow to GitHub without any manual
// UI configuration. No-op when the required env vars are absent, so local dev
// through the UI continues to work.
//
// Idempotent: on every boot it (a) ensures a deterministic org exists,
// (b) refreshes the capture_public_key row's allowed origins (ephemeral tunnel
// URLs change per run), and (c) upserts the GitHub integration row. Never
// creates duplicate orgs or keys.
export async function runEphemeralBootstrap(): Promise<void> {
  const repo = process.env.GITHUB_BOOTSTRAP_REPO?.trim()
  const token = process.env.GITHUB_BOOTSTRAP_TOKEN?.trim()
  const publicKeyValue = process.env.CAPTURE_BOOTSTRAP_PUBLIC_KEY?.trim()
  const originsRaw = process.env.CAPTURE_BOOTSTRAP_ORIGINS?.trim()

  if (!(repo && token && publicKeyValue && originsRaw)) {
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

  await upsertGithubIntegration({
    organizationId,
    repo,
    token,
  })
  console.log(`[bootstrap] GitHub integration configured for ${repo}`)
}
