import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from "bun:test"

type Credentials = {
  siteUrl: string
  email: string
  projectKey: string
  issueType: string
  apiToken: string
  extraFields: Record<string, unknown>
}

const state: {
  credentials: Credentials | null
  createMetaStatus: number
  createMetaFields: Record<string, unknown>
  fetchCount: number
  nonFatalErrors: string[]
} = {
  credentials: null,
  createMetaStatus: 200,
  createMetaFields: {},
  fetchCount: 0,
  nonFatalErrors: [],
}

mock.module("../src/lib/jira-integration-config", () => ({
  getJiraIntegrationCredentials: () => Promise.resolve(state.credentials),
}))

const CREATE_META_FAILED_RE = /create metadata/

const originalFetch = globalThis.fetch
globalThis.fetch = ((url: string | URL | Request) => {
  state.fetchCount += 1
  const u = typeof url === "string" ? url : url.toString()
  if (!u.includes("/rest/api/2/issue/createmeta")) {
    return Promise.reject(new Error(`Unhandled fetch: ${u}`))
  }
  return Promise.resolve(
    new Response(
      JSON.stringify({
        projects: [{ issuetypes: [{ fields: state.createMetaFields }] }],
      }),
      {
        status: state.createMetaStatus,
        headers: { "Content-Type": "application/json" },
      }
    )
  )
}) as typeof fetch

afterAll(() => {
  globalThis.fetch = originalFetch
  mock.restore()
})

let mod: typeof import("../src/lib/jira-fields")
beforeAll(async () => {
  // spyOn rather than mock.module: see jira-integration.test.ts.
  const errorsModule = await import("@crikket/shared/lib/errors")
  spyOn(errorsModule, "reportNonFatalError").mockImplementation(
    (message: string) => {
      state.nonFatalErrors.push(message)
    }
  )
  mod = await import("../src/lib/jira-fields")
})

const NX_FIELDS = {
  summary: { required: true, name: "Summary", schema: { type: "string" } },
  issuetype: {
    required: true,
    name: "Issue Type",
    schema: { type: "issuetype" },
  },
  project: { required: true, name: "Project", schema: { type: "project" } },
  reporter: { required: true, name: "Reporter", schema: { type: "user" } },
  labels: { required: false, name: "Labels", schema: { type: "array" } },
  priority: { required: false, name: "Priority", schema: { type: "priority" } },
  customfield_10173: {
    required: true,
    name: "Genre",
    schema: { type: "option", custom: "select" },
    allowedValues: [
      { id: "10189", value: "Error" },
      { id: "10190", value: "Research" },
    ],
  },
  customfield_11289: {
    required: true,
    name: "Affected Area",
    schema: { type: "option" },
    allowedValues: [{ id: "12682", value: "OnwardFed" }],
  },
  customfield_20000: {
    required: false,
    name: "Team",
    schema: { type: "option" },
    allowedValues: [{ id: "1", value: "Web" }],
  },
  customfield_30000: {
    required: false,
    name: "Tags",
    schema: { type: "array", items: "option" },
    allowedValues: [
      { id: "a", value: "A" },
      { id: "b", value: "B" },
    ],
  },
  customfield_40000: {
    required: true,
    name: "Customer",
    schema: { type: "string" },
  },
  customfield_50000: {
    required: true,
    name: "Sprint",
    schema: { type: "array", items: "json" },
  },
}

function reset(): void {
  state.credentials = {
    siteUrl: "https://acme.atlassian.net",
    email: "bot@acme.test",
    projectKey: "NX",
    issueType: "Bug",
    apiToken: "tok",
    extraFields: {},
  }
  state.createMetaStatus = 200
  state.createMetaFields = NX_FIELDS
  state.fetchCount = 0
  state.nonFatalErrors = []
  mod.clearJiraFieldsCache()
}

beforeEach(reset)
afterEach(reset)

describe("buildReporterFields", () => {
  it("surfaces required non-auto fields with typed options and skips the rest", () => {
    const fields = mod.buildReporterFields(NX_FIELDS, {})
    expect(fields.map((f) => f.id)).toEqual([
      "customfield_10173",
      "customfield_11289",
      "customfield_40000",
    ])
    expect(fields[0]).toEqual({
      id: "customfield_10173",
      name: "Genre",
      required: true,
      type: "select",
      options: [
        { id: "10189", label: "Error" },
        { id: "10190", label: "Research" },
      ],
    })
    expect(fields[2].type).toBe("text")
  })

  it("exposes optional fields the admin pinned, with the pinned value as default", () => {
    const fields = mod.buildReporterFields(NX_FIELDS, {
      customfield_20000: { id: "1" },
      customfield_30000: [{ value: "B" }],
      customfield_10173: { value: "Research" },
    })
    const byId = Object.fromEntries(fields.map((f) => [f.id, f]))
    expect(byId.customfield_20000?.defaultValue).toEqual({ id: "1" })
    expect(byId.customfield_30000?.defaultValue).toEqual([{ id: "b" }])
    // `{value}` resolved to the option id so the widget can preselect it.
    expect(byId.customfield_10173?.defaultValue).toEqual({ id: "10190" })
  })

  it("drops a pinned default that matches no option", () => {
    const fields = mod.buildReporterFields(NX_FIELDS, {
      customfield_10173: { id: "nope" },
    })
    expect(
      fields.find((f) => f.id === "customfield_10173")?.defaultValue
    ).toBeUndefined()
  })
})

describe("sanitizeReporterJiraFields", () => {
  it("keeps only known fields with valid values, normalising option shapes", () => {
    const fields = mod.buildReporterFields(NX_FIELDS, {
      customfield_30000: [],
    })
    const out = mod.sanitizeReporterJiraFields(fields, {
      customfield_10173: "10189",
      customfield_11289: { id: "bogus" },
      customfield_30000: ["a", { id: "b" }, "zzz"],
      customfield_40000: "  Acme Health  ",
      customfield_99999: { id: "1" },
      summary: "injected",
    })
    expect(out).toEqual({
      customfield_10173: { id: "10189" },
      customfield_30000: [{ id: "a" }, { id: "b" }],
      customfield_40000: "Acme Health",
    })
  })

  it("returns an empty object for missing input", () => {
    expect(mod.sanitizeReporterJiraFields([], undefined)).toEqual({})
  })
})

describe("getJiraReporterFields", () => {
  it("returns [] without fetching when the org has no Jira integration", async () => {
    state.credentials = null
    expect(await mod.getJiraReporterFields("org_1")).toEqual([])
    expect(state.fetchCount).toBe(0)
  })

  it("fetches createmeta once and serves the cache afterwards", async () => {
    const first = await mod.getJiraReporterFields("org_1")
    const second = await mod.getJiraReporterFields("org_1")
    expect(first.length).toBe(3)
    expect(second).toBe(first)
    expect(state.fetchCount).toBe(1)
  })

  it("refetches when the integration config changes", async () => {
    await mod.getJiraReporterFields("org_1")
    state.credentials = { ...state.credentials!, projectKey: "OTHER" }
    await mod.getJiraReporterFields("org_1")
    expect(state.fetchCount).toBe(2)
  })

  it("reports a non-fatal error and returns [] when createmeta fails", async () => {
    state.createMetaStatus = 401
    expect(await mod.getJiraReporterFields("org_1")).toEqual([])
    expect(
      state.nonFatalErrors.some((m) => CREATE_META_FAILED_RE.test(m))
    ).toBe(true)
  })
})
