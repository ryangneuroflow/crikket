import { db } from "@crikket/db"
import { capturePublicKey } from "@crikket/db/schema/bug-report"
import { retryOnUniqueViolation } from "@crikket/shared/lib/server/retry-on-unique-violation"
import { and, desc, eq } from "drizzle-orm"
import { nanoid } from "nanoid"

const PUBLIC_KEY_PREFIX = "crk"
const PUBLIC_KEY_RANDOM_LENGTH = 24
const CAPTURE_KEY_STATUS = {
  active: "active",
  revoked: "revoked",
} as const

type CapturePublicKeyStatus =
  (typeof CAPTURE_KEY_STATUS)[keyof typeof CAPTURE_KEY_STATUS]

export interface CapturePublicKeyRecord {
  allowedOrigins: string[]
  createdAt: Date
  createdBy: string | null
  id: string
  key: string
  label: string
  organizationId: string
  revokedAt: Date | null
  rotatedAt: Date | null
  status: CapturePublicKeyStatus
  updatedAt: Date
}

type EnsureCapturePublicKeyForSiteInput = {
  createdBy?: string | null
  label?: string | null
  organizationId: string
  origin: string
}

type CreateCapturePublicKeyInput = {
  allowedOrigins: string[]
  createdBy?: string | null
  label: string
  organizationId: string
}

function buildCapturePublicKey(): string {
  return `${PUBLIC_KEY_PREFIX}_${nanoid(PUBLIC_KEY_RANDOM_LENGTH)}`
}

function buildDefaultSiteLabel(origin: string): string {
  try {
    const parsedOrigin = new URL(origin)
    const hostnameLabel = parsedOrigin.hostname
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
    const portLabel = parsedOrigin.port ? `-${parsedOrigin.port}` : ""

    return `${hostnameLabel || "capture-site"}${portLabel}`.slice(0, 80)
  } catch {
    return "capture-site"
  }
}

function normalizeCaptureKeyLabel(
  value: string | null | undefined,
  origin: string
): string {
  const trimmed = value?.trim()
  return trimmed ? trimmed.slice(0, 80) : buildDefaultSiteLabel(origin)
}

function normalizeCaptureKeyLabelValue(value: string): string {
  return value.trim().slice(0, 80)
}

export function normalizeCaptureOrigin(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) {
    return null
  }

  try {
    const parsedOrigin = new URL(trimmed)
    if (
      parsedOrigin.protocol !== "http:" &&
      parsedOrigin.protocol !== "https:"
    ) {
      return null
    }

    return `${parsedOrigin.protocol.toLowerCase()}//${parsedOrigin.host.toLowerCase()}`
  } catch {
    return null
  }
}

export function normalizeCaptureOrigins(origins: Iterable<string>): string[] {
  const normalizedOrigins = new Set<string>()

  for (const origin of origins) {
    const normalizedOrigin = normalizeCaptureOrigin(origin)
    if (normalizedOrigin) {
      normalizedOrigins.add(normalizedOrigin)
    }
  }

  return Array.from(normalizedOrigins).sort()
}

function requireCaptureOrigins(origins: Iterable<string>): string[] {
  const normalizedOrigins = normalizeCaptureOrigins(origins)

  if (normalizedOrigins.length === 0) {
    throw new Error("At least one valid HTTP(S) origin is required.")
  }

  return normalizedOrigins
}

function toCapturePublicKeyRecord(
  record: typeof capturePublicKey.$inferSelect
): CapturePublicKeyRecord {
  return {
    allowedOrigins: normalizeCaptureOrigins(record.allowedOrigins),
    createdAt: record.createdAt,
    createdBy: record.createdBy,
    id: record.id,
    key: record.key,
    label: record.label,
    organizationId: record.organizationId,
    revokedAt: record.revokedAt,
    rotatedAt: record.rotatedAt,
    status: record.status as CapturePublicKeyStatus,
    updatedAt: record.updatedAt,
  }
}

export function isCapturePublicKeyActive(
  record: Pick<CapturePublicKeyRecord, "status">
): boolean {
  return record.status === CAPTURE_KEY_STATUS.active
}

/**
 * Match a concrete request origin against a single allowed-origin entry.
 *
 * Entries are exact origins ("http://app.example.com") unless they contain a
 * "*", which acts as a single-DNS-label wildcard in the host — mirroring TLS
 * wildcard-cert semantics. So "http://*.localhost:5173" matches
 * "http://research-lab.localhost:5173" but NOT the bare apex
 * "http://localhost:5173" (list that separately) nor a multi-label host
 * "http://a.b.localhost:5173". Both sides are already lowercased by
 * normalizeCaptureOrigin, so the comparison is case-stable.
 */
export function captureOriginMatches(origin: string, allowed: string): boolean {
  if (!allowed.includes("*")) {
    return origin === allowed
  }
  // Escape every regex metacharacter in the trusted (admin-configured) pattern,
  // then re-expand the escaped "*" into a single-label matcher: [^.:/]+ refuses
  // to cross a dot, the port colon, or a path separator, so the wildcard can
  // only stand in for one subdomain label.
  const pattern = allowed
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\\\*/g, "[^.:/]+")
  return new RegExp(`^${pattern}$`).test(origin)
}

export function isCaptureOriginAllowed(input: {
  origin: string
  record: Pick<CapturePublicKeyRecord, "allowedOrigins" | "status">
}): boolean {
  const normalizedOrigin = normalizeCaptureOrigin(input.origin)
  if (!(normalizedOrigin && isCapturePublicKeyActive(input.record))) {
    return false
  }

  return input.record.allowedOrigins.some((allowed) =>
    captureOriginMatches(normalizedOrigin, allowed)
  )
}

async function findActiveCapturePublicKeyForOrigin(input: {
  organizationId: string
  origin: string
}): Promise<CapturePublicKeyRecord | null> {
  const records = await db.query.capturePublicKey.findMany({
    where: and(
      eq(capturePublicKey.organizationId, input.organizationId),
      eq(capturePublicKey.status, CAPTURE_KEY_STATUS.active)
    ),
    orderBy: (table, { asc }) => [asc(table.createdAt)],
  })

  const matchingRecord = records.find((record) =>
    record.allowedOrigins.includes(input.origin)
  )

  return matchingRecord ? toCapturePublicKeyRecord(matchingRecord) : null
}

export async function listCapturePublicKeys(input: {
  organizationId: string
}): Promise<CapturePublicKeyRecord[]> {
  const records = await db.query.capturePublicKey.findMany({
    where: eq(capturePublicKey.organizationId, input.organizationId),
    orderBy: [
      desc(capturePublicKey.updatedAt),
      desc(capturePublicKey.createdAt),
    ],
  })

  return records.map(toCapturePublicKeyRecord)
}

export async function ensureCapturePublicKeyForSite(
  input: EnsureCapturePublicKeyForSiteInput
): Promise<CapturePublicKeyRecord> {
  const normalizedOrigin = normalizeCaptureOrigin(input.origin)
  if (!normalizedOrigin) {
    throw new Error("A valid HTTP(S) origin is required for capture keys.")
  }

  const existingRecord = await findActiveCapturePublicKeyForOrigin({
    organizationId: input.organizationId,
    origin: normalizedOrigin,
  })

  if (existingRecord) {
    return existingRecord
  }

  return retryOnUniqueViolation(async () => {
    const key = buildCapturePublicKey()
    const createdValues = {
      id: nanoid(16),
      organizationId: input.organizationId,
      key,
      label: normalizeCaptureKeyLabel(input.label, normalizedOrigin),
      allowedOrigins: [normalizedOrigin],
      status: CAPTURE_KEY_STATUS.active,
      createdBy: input.createdBy ?? null,
      rotatedAt: null,
    }

    const [createdRecord] = await db
      .insert(capturePublicKey)
      .values(createdValues)
      .returning()

    if (!createdRecord) {
      throw new Error("Failed to create capture public key.")
    }

    return toCapturePublicKeyRecord(createdRecord)
  })
}

export function createCapturePublicKey(
  input: CreateCapturePublicKeyInput
): Promise<CapturePublicKeyRecord> {
  const allowedOrigins = requireCaptureOrigins(input.allowedOrigins)
  const label = normalizeCaptureKeyLabelValue(input.label)

  if (!label) {
    throw new Error("Capture key label is required.")
  }

  return retryOnUniqueViolation(async () => {
    const [createdRecord] = await db
      .insert(capturePublicKey)
      .values({
        allowedOrigins,
        createdBy: input.createdBy ?? null,
        id: nanoid(16),
        key: buildCapturePublicKey(),
        label,
        organizationId: input.organizationId,
        revokedAt: null,
        rotatedAt: null,
        status: CAPTURE_KEY_STATUS.active,
      })
      .returning()

    if (!createdRecord) {
      throw new Error("Failed to create capture public key.")
    }

    return toCapturePublicKeyRecord(createdRecord)
  })
}

export async function resolveCapturePublicKey(
  publicKey: string
): Promise<CapturePublicKeyRecord | null> {
  const normalizedKey = publicKey.trim()
  if (!normalizedKey) {
    return null
  }

  const record = await db.query.capturePublicKey.findFirst({
    where: eq(capturePublicKey.key, normalizedKey),
  })

  return record ? toCapturePublicKeyRecord(record) : null
}

export async function updateCapturePublicKeyOrigins(input: {
  allowedOrigins: string[]
  keyId: string
  organizationId: string
}): Promise<CapturePublicKeyRecord | null> {
  const allowedOrigins = requireCaptureOrigins(input.allowedOrigins)

  const [updatedRecord] = await db
    .update(capturePublicKey)
    .set({
      allowedOrigins,
    })
    .where(
      and(
        eq(capturePublicKey.id, input.keyId),
        eq(capturePublicKey.organizationId, input.organizationId)
      )
    )
    .returning()

  return updatedRecord ? toCapturePublicKeyRecord(updatedRecord) : null
}

export async function updateCapturePublicKeyDetails(input: {
  allowedOrigins: string[]
  keyId: string
  label: string
  organizationId: string
}): Promise<CapturePublicKeyRecord | null> {
  const allowedOrigins = requireCaptureOrigins(input.allowedOrigins)
  const label = normalizeCaptureKeyLabelValue(input.label)

  if (!label) {
    throw new Error("Capture key label is required.")
  }

  const [updatedRecord] = await db
    .update(capturePublicKey)
    .set({
      allowedOrigins,
      label,
    })
    .where(
      and(
        eq(capturePublicKey.id, input.keyId),
        eq(capturePublicKey.organizationId, input.organizationId)
      )
    )
    .returning()

  return updatedRecord ? toCapturePublicKeyRecord(updatedRecord) : null
}

export async function revokeCapturePublicKey(input: {
  keyId: string
  organizationId: string
}): Promise<boolean> {
  const [updatedRecord] = await db
    .update(capturePublicKey)
    .set({
      status: CAPTURE_KEY_STATUS.revoked,
      revokedAt: new Date(),
    })
    .where(
      and(
        eq(capturePublicKey.id, input.keyId),
        eq(capturePublicKey.organizationId, input.organizationId)
      )
    )
    .returning({
      id: capturePublicKey.id,
    })

  return Boolean(updatedRecord)
}

export async function deleteCapturePublicKey(input: {
  keyId: string
  organizationId: string
}): Promise<boolean> {
  const existingRecord = await db.query.capturePublicKey.findFirst({
    where: and(
      eq(capturePublicKey.id, input.keyId),
      eq(capturePublicKey.organizationId, input.organizationId)
    ),
    columns: {
      id: true,
    },
  })

  if (!existingRecord) {
    return false
  }

  await db
    .delete(capturePublicKey)
    .where(
      and(
        eq(capturePublicKey.id, input.keyId),
        eq(capturePublicKey.organizationId, input.organizationId)
      )
    )

  return true
}

export function rotateCapturePublicKey(input: {
  keyId: string
  organizationId: string
}): Promise<CapturePublicKeyRecord | null> {
  return retryOnUniqueViolation(async () => {
    const [updatedRecord] = await db
      .update(capturePublicKey)
      .set({
        key: buildCapturePublicKey(),
        revokedAt: null,
        rotatedAt: new Date(),
        status: CAPTURE_KEY_STATUS.active,
      })
      .where(
        and(
          eq(capturePublicKey.id, input.keyId),
          eq(capturePublicKey.organizationId, input.organizationId)
        )
      )
      .returning()

    return updatedRecord ? toCapturePublicKeyRecord(updatedRecord) : null
  })
}
