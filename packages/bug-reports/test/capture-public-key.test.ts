import { describe, expect, it, mock } from "bun:test"

// capture-public-key.ts imports the drizzle db client + schema at module load.
// The pure origin matcher under test touches neither, so stub them out to keep
// this a dependency-free unit test (mirrors signed-url-utils.test.ts).
mock.module("@crikket/db", () => ({ db: {} }))
mock.module("@crikket/db/schema/bug-report", () => ({ capturePublicKey: {} }))

const { captureOriginMatches, isCaptureOriginAllowed } = await import(
  "../src/lib/capture-public-key"
)

describe("captureOriginMatches", () => {
  it("matches an exact origin and rejects any other", () => {
    expect(
      captureOriginMatches("http://localhost:5173", "http://localhost:5173")
    ).toBe(true)
    expect(
      captureOriginMatches("http://evil.example", "http://localhost:5173")
    ).toBe(false)
  })

  it("matches any single-label subdomain against a host wildcard", () => {
    const pattern = "http://*.localhost:5173"
    for (const sub of ["research-lab", "main-campus", "brand-new-site"]) {
      expect(captureOriginMatches(`http://${sub}.localhost:5173`, pattern)).toBe(
        true
      )
    }
  })

  it("does not let a host wildcard match the bare apex", () => {
    // "*" stands in for one label, so the apex (no leading label) is excluded —
    // it must be listed explicitly alongside the wildcard.
    expect(
      captureOriginMatches("http://localhost:5173", "http://*.localhost:5173")
    ).toBe(false)
  })

  it("does not let a single-label wildcard cross a dot, port, or scheme", () => {
    const pattern = "http://*.localhost:5173"
    expect(captureOriginMatches("http://a.b.localhost:5173", pattern)).toBe(
      false
    ) // multi-label
    expect(captureOriginMatches("http://app.localhost:6006", pattern)).toBe(
      false
    ) // different port
    expect(captureOriginMatches("https://app.localhost:5173", pattern)).toBe(
      false
    ) // different scheme
  })

  it("treats regex metacharacters in the pattern as literals", () => {
    // The "." in the pattern must match a literal dot, not any character.
    expect(
      captureOriginMatches("http://localhostX5173", "http://localhost.5173")
    ).toBe(false)
  })
})

describe("isCaptureOriginAllowed", () => {
  it("allows the apex via its explicit entry and subdomains via the wildcard", () => {
    const record = {
      status: "active" as const,
      allowedOrigins: ["http://localhost:5173", "http://*.localhost:5173"],
    }
    expect(
      isCaptureOriginAllowed({ origin: "http://localhost:5173", record })
    ).toBe(true)
    expect(
      isCaptureOriginAllowed({
        origin: "http://research-lab.localhost:5173",
        record,
      })
    ).toBe(true)
  })

  it("rejects when no entry matches", () => {
    const record = {
      status: "active" as const,
      allowedOrigins: ["http://*.localhost:5173"],
    }
    expect(
      isCaptureOriginAllowed({ origin: "http://evil.example", record })
    ).toBe(false)
  })

  it("rejects when the key is not active, even on a matching origin", () => {
    const record = {
      status: "revoked" as const,
      allowedOrigins: ["http://*.localhost:5173"],
    }
    expect(
      isCaptureOriginAllowed({
        origin: "http://research-lab.localhost:5173",
        record,
      })
    ).toBe(false)
  })
})
