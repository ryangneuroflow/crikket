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

// ----- Mutable state wired into the module-level mocks below ---------------

type Report = {
  id: string
  organizationId: string
  title: string | null
  description: string | null
  priority: string
  url: string | null
  status: string
  tags: string[] | null
  attachmentType: string | null
  deviceInfo: unknown
  metadata: unknown
  createdAt: Date
  captureKey: string | null
  debuggerKey: string | null
  debuggerContentEncoding: string | null
  logs: Array<{ level: string; message: string; timestamp: Date }>
  networkRequests: Array<{
    method: string
    url: string
    status: number | null
    duration: number | null
    responseBody: string | null
    timestamp: Date
  }>
  actions: Array<{
    type: string
    target: string | null
    offset: number | null
    metadata: unknown
    timestamp: Date
  }>
}

type Credentials = {
  siteUrl: string
  email: string
  projectKey: string
  issueType: string
  subtaskIssueType: string | null
  apiToken: string
  extraFields: Record<string, unknown>
}

const state: {
  report: Report | null
  credentials: Credentials | null
  captureBytes: Buffer | null
  debuggerBytes: Buffer | null
  // Fetch-side state
  createResponses: Array<{ status: number; body: unknown }>
  parentIssueType: {
    name: string
    subtask: boolean
    hierarchyLevel?: number
  } | null
  projectIssueTypes: Array<{ name: string; subtask: boolean }>
  attachmentStatus: number
  updateStatus: number
  linkStatus: number
  nonFatalErrors: Array<{ message: string; error: unknown }>
} = {
  report: null,
  credentials: null,
  captureBytes: null,
  debuggerBytes: null,
  createResponses: [],
  parentIssueType: { name: "Epic", subtask: false, hierarchyLevel: 1 },
  projectIssueTypes: [
    { name: "Bug", subtask: false },
    { name: "Sub-task", subtask: true },
  ],
  attachmentStatus: 200,
  updateStatus: 204,
  linkStatus: 201,
  nonFatalErrors: [],
}

mock.module("@crikket/env/server", () => ({
  env: {
    DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/crikket",
    BETTER_AUTH_SECRET: "0123456789abcdef0123456789abcdef",
    BETTER_AUTH_URL: "http://localhost:3000",
    STORAGE_BUCKET: "bug-report-bucket",
    STORAGE_REGION: "us-east-1",
    STORAGE_ENDPOINT: "https://s3.us-east-1.amazonaws.com",
    STORAGE_ACCESS_KEY_ID: "access",
    STORAGE_SECRET_ACCESS_KEY: "secret",
  },
}))

mock.module("@crikket/db", () => ({
  db: {
    query: {
      bugReport: {
        findFirst: () => Promise.resolve(state.report),
      },
      bugReportArtifactCleanup: {
        findMany: () => Promise.resolve([]),
        findFirst: () => Promise.resolve(null),
      },
    },
  },
}))

mock.module("../src/lib/jira-integration-config", () => ({
  getJiraIntegrationCredentials: () => Promise.resolve(state.credentials),
}))

// ----- Fetch mock -----------------------------------------------------------

interface RecordedCall {
  url: string
  method: string
  headers: Record<string, string>
  body?: unknown
  formFilenames?: string[]
}

const fetchCalls: RecordedCall[] = []

const ISSUE_CREATE_RE = /\/rest\/api\/2\/issue$/
const ISSUE_UPDATE_RE = /\/rest\/api\/2\/issue\/[^/]+$/
const ATTACHMENTS_RE = /\/rest\/api\/2\/issue\/[^/]+\/attachments$/
const ISSUE_LINK_RE = /\/rest\/api\/2\/issueLink$/
const ISSUE_GET_RE = /\/rest\/api\/2\/issue\/[^/?]+\?fields=issuetype$/
const PROJECT_GET_RE = /\/rest\/api\/2\/project\/[^/]+$/
const NOT_FOUND_RE = /not found/i
const CREATE_FAILED_RE = /Failed to create Jira issue/i
const REJECTED_FIELDS_RE = /rejected field\(s\)/i
const UPDATE_FAILED_RE = /Failed to update ABC-42/

function jsonResponse(status: number, body: unknown): Promise<Response> {
  return Promise.resolve(
    new Response(status === 204 ? null : JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    })
  )
}

const originalFetch = globalThis.fetch
globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
  const u =
    typeof url === "string"
      ? url
      : url instanceof URL
        ? url.toString()
        : url.url
  const method = (init?.method ?? "GET").toUpperCase()
  const headers = Object.fromEntries(
    Object.entries((init?.headers as Record<string, string>) ?? {})
  )
  let body: unknown
  let formFilenames: string[] | undefined
  if (init?.body instanceof FormData) {
    formFilenames = []
    for (const [, value] of init.body.entries()) {
      if (value instanceof Blob) {
        formFilenames.push((value as File).name ?? "<blob>")
      }
    }
  } else if (init?.body && typeof init.body === "string") {
    try {
      body = JSON.parse(init.body)
    } catch {
      body = init.body
    }
  }
  fetchCalls.push({ url: u, method, headers, body, formFilenames })

  if (method === "POST" && ISSUE_CREATE_RE.test(u)) {
    const next = state.createResponses.shift() ?? {
      status: 201,
      body: { id: "10042", key: "ABC-42", self: `${u}/10042` },
    }
    return jsonResponse(next.status, next.body)
  }
  if (method === "POST" && ATTACHMENTS_RE.test(u)) {
    return jsonResponse(state.attachmentStatus, [{ id: "1" }])
  }
  if (method === "PUT" && ISSUE_UPDATE_RE.test(u)) {
    return jsonResponse(state.updateStatus, {})
  }
  if (method === "POST" && ISSUE_LINK_RE.test(u)) {
    return jsonResponse(state.linkStatus, {})
  }
  if (method === "GET" && ISSUE_GET_RE.test(u)) {
    return state.parentIssueType
      ? jsonResponse(200, { fields: { issuetype: state.parentIssueType } })
      : jsonResponse(404, { errorMessages: ["Issue does not exist"] })
  }
  if (method === "GET" && PROJECT_GET_RE.test(u)) {
    return jsonResponse(200, { issueTypes: state.projectIssueTypes })
  }
  return Promise.reject(new Error(`Unhandled fetch: ${method} ${u}`))
}) as typeof fetch

afterAll(() => {
  globalThis.fetch = originalFetch
  mock.restore()
})

// ----- Module under test ----------------------------------------------------

let forwardBugReportToJira: typeof import("../src/lib/jira-integration").forwardBugReportToJira
let createJiraIssue: typeof import("../src/lib/jira-integration").createJiraIssue
let attachAndUpdateJiraIssue: typeof import("../src/lib/jira-integration").attachAndUpdateJiraIssue
let parseJiraParentIssueRef: typeof import("../src/lib/jira-integration").parseJiraParentIssueRef
let clearJiraSubtaskTypeCache: typeof import("../src/lib/jira-integration").clearJiraSubtaskTypeCache

// Spies rather than mock.module for these two: module mocks are process-wide
// in bun and would replace the real storage/errors exports for every other
// test file in the run. Dynamic imports so the env/db mocks above are in
// place before the modules evaluate.
beforeAll(async () => {
  const errorsModule = await import("@crikket/shared/lib/errors")
  spyOn(errorsModule, "reportNonFatalError").mockImplementation(
    (message: string, error: unknown) => {
      state.nonFatalErrors.push({ message, error })
    }
  )
  const storageModule = await import("../src/lib/storage")
  spyOn(storageModule, "getStorageProvider").mockImplementation(
    () =>
      ({
        read: (key: string): Promise<Buffer> => {
          if (state.report?.captureKey && key === state.report.captureKey) {
            return Promise.resolve(state.captureBytes ?? Buffer.alloc(0))
          }
          if (state.report?.debuggerKey && key === state.report.debuggerKey) {
            return Promise.resolve(state.debuggerBytes ?? Buffer.alloc(0))
          }
          return Promise.reject(new Error(`unknown storage key: ${key}`))
        },
      }) as unknown as ReturnType<typeof storageModule.getStorageProvider>
  )
  ;({
    forwardBugReportToJira,
    createJiraIssue,
    attachAndUpdateJiraIssue,
    parseJiraParentIssueRef,
    clearJiraSubtaskTypeCache,
  } = await import("../src/lib/jira-integration"))
})

// ----- Helpers --------------------------------------------------------------

function makeCredentials(overrides: Partial<Credentials> = {}): Credentials {
  return {
    siteUrl: "https://acme.atlassian.net",
    email: "bot@acme.test",
    projectKey: "ABC",
    issueType: "Bug",
    subtaskIssueType: null,
    apiToken: "tok_secret",
    extraFields: {},
    ...overrides,
  }
}

function makeReport(overrides: Partial<Report> = {}): Report {
  return {
    id: "br_abc123",
    organizationId: "org_test",
    title: "Button does not submit",
    description: "Clicking Save does nothing on the settings page.",
    priority: "high",
    url: "https://app.example.com/settings",
    status: "new",
    tags: ["settings", "regression"],
    attachmentType: "screenshot",
    deviceInfo: {
      browser: "Chrome 131",
      os: "macOS",
      viewport: "1440x900",
    },
    metadata: {
      duration: "2s",
      durationMs: 2000,
      sdkVersion: "1.0.0",
      submittedVia: "widget",
    },
    createdAt: new Date("2026-04-22T16:00:00Z"),
    captureKey:
      "organizations/org_test/bug-reports/br_abc123/capture/screenshot.png",
    debuggerKey:
      "organizations/org_test/bug-reports/br_abc123/debugger/payload.json.gz",
    debuggerContentEncoding: null,
    logs: [
      {
        level: "error",
        message: "Uncaught TypeError: cannot read properties of undefined",
        timestamp: new Date("2026-04-22T16:00:01Z"),
      },
    ],
    networkRequests: [
      {
        method: "POST",
        url: "https://api.example.com/v1/settings",
        status: 500,
        duration: 423,
        responseBody: '{"detail":"Internal server error"}',
        timestamp: new Date("2026-04-22T16:00:03Z"),
      },
    ],
    actions: [
      {
        type: "click",
        target: "button#save",
        offset: 1500,
        metadata: null,
        timestamp: new Date("2026-04-22T16:00:00Z"),
      },
      {
        type: "navigation",
        target: "window",
        offset: 2500,
        metadata: {
          mode: "pushState",
          url: "http://localhost:5173/auth/register",
          path: "/auth/register",
        },
        timestamp: new Date("2026-04-22T16:00:01Z"),
      },
    ],
    ...overrides,
  }
}

function resetState(): void {
  state.report = null
  state.credentials = null
  state.captureBytes = null
  state.debuggerBytes = null
  state.createResponses = []
  state.parentIssueType = { name: "Epic", subtask: false, hierarchyLevel: 1 }
  state.projectIssueTypes = [
    { name: "Bug", subtask: false },
    { name: "Sub-task", subtask: true },
  ]
  state.attachmentStatus = 200
  state.updateStatus = 204
  state.linkStatus = 201
  state.nonFatalErrors = []
  fetchCalls.length = 0
}

function issueCreates(): RecordedCall[] {
  return fetchCalls.filter(
    (c) => c.method === "POST" && ISSUE_CREATE_RE.test(c.url)
  )
}

function lastIssueCreate(): RecordedCall | undefined {
  return issueCreates().at(-1)
}

function lastIssueUpdate(): RecordedCall | undefined {
  return [...fetchCalls]
    .reverse()
    .find((c) => c.method === "PUT" && ISSUE_UPDATE_RE.test(c.url))
}

function attachmentPosts(): RecordedCall[] {
  return fetchCalls.filter(
    (c) => c.method === "POST" && ATTACHMENTS_RE.test(c.url)
  )
}

function lastIssueLink(): RecordedCall | undefined {
  return [...fetchCalls]
    .reverse()
    .find((c) => c.method === "POST" && ISSUE_LINK_RE.test(c.url))
}

function createFields(call: RecordedCall | undefined): Record<string, unknown> {
  return ((call?.body as { fields?: Record<string, unknown> })?.fields ??
    {}) as Record<string, unknown>
}

function updatedDescription(): string {
  const body = lastIssueUpdate()?.body as {
    fields?: { description?: string }
  }
  return body?.fields?.description ?? ""
}

beforeEach(() => {
  resetState()
  clearJiraSubtaskTypeCache()
})
afterEach(() => {
  resetState()
})

// ----- Tests ----------------------------------------------------------------

describe("parseJiraParentIssueRef", () => {
  it("accepts a bare issue key and upper-cases it", () => {
    expect(parseJiraParentIssueRef("abc-12")).toBe("ABC-12")
  })

  it("accepts a /browse/ URL on any host, with a trailing query", () => {
    expect(
      parseJiraParentIssueRef(
        "https://acme.atlassian.net/browse/ABC-12?focusedCommentId=1"
      )
    ).toBe("ABC-12")
    expect(
      parseJiraParentIssueRef("https://jira.acme.internal/jira/browse/ops-7/")
    ).toBe("OPS-7")
  })

  it("returns null for GitHub-form refs and empty input", () => {
    expect(parseJiraParentIssueRef("#123")).toBeNull()
    expect(parseJiraParentIssueRef("123")).toBeNull()
    expect(
      parseJiraParentIssueRef("https://github.com/acme/app/issues/123")
    ).toBeNull()
    expect(parseJiraParentIssueRef("   ")).toBeNull()
  })
})

describe("createJiraIssue: guard rails", () => {
  it("returns null when the report does not exist", async () => {
    state.report = null
    state.credentials = makeCredentials()
    expect(await createJiraIssue("missing")).toBeNull()
    expect(issueCreates()).toHaveLength(0)
    expect(state.nonFatalErrors.some((e) => NOT_FOUND_RE.test(e.message))).toBe(
      true
    )
  })

  it("returns null without calling Jira when the org has no integration", async () => {
    state.report = makeReport()
    state.credentials = null
    expect(await createJiraIssue("br_abc123")).toBeNull()
    expect(fetchCalls).toHaveLength(0)
    expect(state.nonFatalErrors).toHaveLength(0)
  })

  it("reports a non-fatal error and returns null when the POST fails", async () => {
    state.report = makeReport()
    state.credentials = makeCredentials()
    state.createResponses = [
      { status: 401, body: { errorMessages: ["Unauthorized"] } },
    ]
    expect(await createJiraIssue("br_abc123")).toBeNull()
    expect(
      state.nonFatalErrors.some((e) => CREATE_FAILED_RE.test(e.message))
    ).toBe(true)
  })
})

describe("createJiraIssue: request shape", () => {
  beforeEach(() => {
    state.report = makeReport()
    state.credentials = makeCredentials()
  })

  it("posts to the site's v2 issue endpoint with Basic auth", async () => {
    await createJiraIssue("br_abc123")
    const call = lastIssueCreate()
    expect(call?.url).toBe("https://acme.atlassian.net/rest/api/2/issue")
    const expected = Buffer.from("bot@acme.test:tok_secret").toString("base64")
    expect(call?.headers.Authorization).toBe(`Basic ${expected}`)
  })

  it("builds project, issue type, summary, labels, and priority from the report", async () => {
    const created = await createJiraIssue("br_abc123")
    const fields = createFields(lastIssueCreate())
    expect(fields.project).toEqual({ key: "ABC" })
    expect(fields.issuetype).toEqual({ name: "Bug" })
    expect(fields.summary).toBe("[crikket] Button does not submit")
    expect(fields.labels).toEqual(["crikket", "priority-high"])
    expect(fields.priority).toEqual({ name: "High" })
    expect(created?.key).toBe("ABC-42")
    expect(created?.browseUrl).toBe("https://acme.atlassian.net/browse/ABC-42")
  })

  it("omits the priority field and label when priority is 'none'", async () => {
    state.report = makeReport({ priority: "none" })
    await createJiraIssue("br_abc123")
    const fields = createFields(lastIssueCreate())
    expect(fields.labels).toEqual(["crikket"])
    expect(fields.priority).toBeUndefined()
  })

  it("renders the description in wiki markup with context, steps, logs, and network rows", async () => {
    await createJiraIssue("br_abc123")
    const description = createFields(lastIssueCreate()).description as string
    expect(description).toContain("h2. Description")
    expect(description).toContain("Clicking Save does nothing")
    expect(description).toContain("||Field||Value||")
    expect(description).toContain("|Browser|Chrome 131|")
    expect(description).toContain("|Tags|settings, regression|")
    expect(description).toContain("h2. Reproduction steps")
    expect(description).toContain("# *click* — {{button#save}} _(+1.5s)_")
    expect(description).toContain("{{/auth/register}} _(pushState)_")
    expect(description).toContain("{noformat}")
    expect(description).toContain("ERROR: Uncaught TypeError")
    expect(description).toContain("||Method||Status||Duration||URL||Response||")
    expect(description).toContain('{{\\{"detail":"Internal server error"}}}')
    // No attachments in the initial create.
    expect(description).not.toContain("h2. Artifacts")
  })

  it("neutralises table-breaking characters in user-supplied values", async () => {
    state.report = makeReport({
      tags: ["a|b", "{macro}"],
      url: "https://app.example.com/?q=[x]",
    })
    await createJiraIssue("br_abc123")
    const description = createFields(lastIssueCreate()).description as string
    expect(description).toContain("|Tags|a¦b, \\{macro}|")
    expect(description).toContain("|URL|https://app.example.com/?q=\\[x]|")
  })

  it("falls back to the URL, then the id, for the summary", async () => {
    state.report = makeReport({ title: null })
    await createJiraIssue("br_abc123")
    expect(createFields(lastIssueCreate()).summary).toBe(
      "[crikket] Bug report from https://app.example.com/settings"
    )
    state.report = makeReport({ title: "  ", url: null })
    await createJiraIssue("br_abc123")
    expect(createFields(lastIssueCreate()).summary).toBe(
      "[crikket] Bug report br_abc123"
    )
  })

  it("merges admin-configured extra fields, letting pinned priority and labels through", async () => {
    state.credentials = makeCredentials({
      extraFields: {
        customfield_10173: { id: "10189" },
        priority: { id: "3" },
        labels: ["onward"],
        summary: "should be overridden",
      },
    })
    await createJiraIssue("br_abc123")
    const fields = createFields(lastIssueCreate())
    expect(fields.customfield_10173).toEqual({ id: "10189" })
    expect(fields.priority).toEqual({ id: "3" })
    expect(fields.labels).toEqual(["onward", "crikket", "priority-high"])
    expect(fields.summary).toBe("[crikket] Button does not submit")
  })

  it("lets reporter-chosen values override admin defaults but not core fields", async () => {
    state.credentials = makeCredentials({
      extraFields: {
        customfield_10173: { id: "10189" },
        customfield_11289: { id: "12682" },
      },
    })
    await createJiraIssue("br_abc123", {
      jiraFields: {
        customfield_10173: { id: "10190" },
        summary: "reporter can't touch this",
      },
    })
    const fields = createFields(lastIssueCreate())
    expect(fields.customfield_10173).toEqual({ id: "10190" })
    expect(fields.customfield_11289).toEqual({ id: "12682" })
    expect(fields.summary).toBe("[crikket] Button does not submit")
  })

  it("retries once without the fields Jira rejects as off-screen", async () => {
    state.createResponses = [
      {
        status: 400,
        body: {
          errorMessages: [],
          errors: {
            priority:
              "Field 'priority' cannot be set. It is not on the appropriate screen, or unknown.",
          },
        },
      },
    ]
    const created = await createJiraIssue("br_abc123")
    expect(created?.key).toBe("ABC-42")
    const creates = issueCreates()
    expect(creates).toHaveLength(2)
    expect(createFields(creates[0]).priority).toBeDefined()
    expect(createFields(creates[1]).priority).toBeUndefined()
    expect(createFields(creates[1]).labels).toEqual([
      "crikket",
      "priority-high",
    ])
    expect(
      state.nonFatalErrors.some((e) => REJECTED_FIELDS_RE.test(e.message))
    ).toBe(true)
  })

  it("gives up after the retry when Jira rejects a required field", async () => {
    const bad = {
      status: 400,
      body: { errorMessages: [], errors: { summary: "Required" } },
    }
    state.createResponses = [bad, bad]
    expect(await createJiraIssue("br_abc123")).toBeNull()
    expect(issueCreates()).toHaveLength(1)
    expect(
      state.nonFatalErrors.some((e) => CREATE_FAILED_RE.test(e.message))
    ).toBe(true)
  })
})

describe("createJiraIssue: parent linking", () => {
  beforeEach(() => {
    state.report = makeReport()
    state.credentials = makeCredentials()
  })

  it("sets the parent field when a Jira key is supplied", async () => {
    const created = await createJiraIssue("br_abc123", {
      parentIssueRef: "abc-7",
    })
    expect(createFields(lastIssueCreate()).parent).toEqual({ key: "ABC-7" })
    expect(created?.parentIssueKey).toBe("ABC-7")
    expect(lastIssueLink()).toBeUndefined()
  })

  it("accepts a /browse/ URL", async () => {
    await createJiraIssue("br_abc123", {
      parentIssueRef: "https://acme.atlassian.net/browse/ABC-9",
    })
    expect(createFields(lastIssueCreate()).parent).toEqual({ key: "ABC-9" })
  })

  it("falls back to a 'Relates' issue link when Jira rejects the parent field", async () => {
    state.createResponses = [
      {
        status: 400,
        body: {
          errorMessages: [],
          errors: {
            parent:
              "Given parent work item does not belong to appropriate hierarchy.",
          },
        },
      },
    ]
    const created = await createJiraIssue("br_abc123", {
      parentIssueRef: "ABC-7",
    })
    expect(created?.key).toBe("ABC-42")
    expect(createFields(lastIssueCreate()).parent).toBeUndefined()
    const link = lastIssueLink()
    expect(link?.body).toEqual({
      type: { name: "Relates" },
      inwardIssue: { key: "ABC-42" },
      outwardIssue: { key: "ABC-7" },
    })
    expect(created?.parentIssueKey).toBe("ABC-7")
  })

  it("reports parentIssueKey as null when the fallback link also fails", async () => {
    state.createResponses = [
      { status: 400, body: { errors: { parent: "nope" } } },
    ]
    state.linkStatus = 404
    const created = await createJiraIssue("br_abc123", {
      parentIssueRef: "ABC-7",
    })
    expect(created?.key).toBe("ABC-42")
    expect(created?.parentIssueKey).toBeNull()
  })

  it("creates a sub-task under a Story parent using the configured sub-task type", async () => {
    state.parentIssueType = { name: "Story", subtask: false, hierarchyLevel: 0 }
    state.credentials = makeCredentials({ subtaskIssueType: "Bug sub-task" })
    const created = await createJiraIssue("br_abc123", {
      parentIssueRef: "ABC-7",
    })
    const fields = createFields(lastIssueCreate())
    expect(fields.issuetype).toEqual({ name: "Bug sub-task" })
    expect(fields.parent).toEqual({ key: "ABC-7" })
    expect(created?.parentIssueKey).toBe("ABC-7")
    expect(lastIssueLink()).toBeUndefined()
  })

  it("discovers the project's sub-task type when none is configured", async () => {
    state.parentIssueType = { name: "Task", subtask: false, hierarchyLevel: 0 }
    state.projectIssueTypes = [
      { name: "Bug", subtask: false },
      { name: "Subtarea", subtask: true },
    ]
    await createJiraIssue("br_abc123", { parentIssueRef: "ABC-7" })
    expect(createFields(lastIssueCreate()).issuetype).toEqual({
      name: "Subtarea",
    })
    // Second call hits the cache: no extra project lookup.
    const projectGets = () =>
      fetchCalls.filter((c) => c.method === "GET" && PROJECT_GET_RE.test(c.url))
        .length
    const before = projectGets()
    await createJiraIssue("br_abc123", { parentIssueRef: "ABC-8" })
    expect(projectGets()).toBe(before)
  })

  it("treats a Data Center Story (no hierarchyLevel) as standard-level", async () => {
    state.parentIssueType = { name: "Story", subtask: false }
    await createJiraIssue("br_abc123", { parentIssueRef: "ABC-7" })
    expect(createFields(lastIssueCreate()).issuetype).toEqual({
      name: "Sub-task",
    })
  })

  it("keeps a Bug with the parent field for an Epic parent", async () => {
    state.parentIssueType = { name: "Epic", subtask: false, hierarchyLevel: 1 }
    await createJiraIssue("br_abc123", { parentIssueRef: "ABC-7" })
    const fields = createFields(lastIssueCreate())
    expect(fields.issuetype).toEqual({ name: "Bug" })
    expect(fields.parent).toEqual({ key: "ABC-7" })
  })

  it("links instead of nesting when the parent is itself a sub-task", async () => {
    state.parentIssueType = {
      name: "Sub-task",
      subtask: true,
      hierarchyLevel: -1,
    }
    const created = await createJiraIssue("br_abc123", {
      parentIssueRef: "ABC-7",
    })
    const fields = createFields(lastIssueCreate())
    expect(fields.issuetype).toEqual({ name: "Bug" })
    expect(fields.parent).toBeUndefined()
    expect(lastIssueLink()?.body).toMatchObject({
      outwardIssue: { key: "ABC-7" },
    })
    expect(created?.parentIssueKey).toBe("ABC-7")
  })

  it("falls back to a top-level Bug plus a link when the sub-task create fails", async () => {
    state.parentIssueType = { name: "Story", subtask: false, hierarchyLevel: 0 }
    // The rejected field isn't one we sent, so there's nothing to drop and
    // the sub-task attempt fails outright; the Bug fallback then succeeds.
    state.createResponses = [
      {
        status: 400,
        body: { errors: { customfield_777: "Required for sub-tasks." } },
      },
    ]
    const created = await createJiraIssue("br_abc123", {
      parentIssueRef: "ABC-7",
    })
    expect(created?.key).toBe("ABC-42")
    const creates = issueCreates()
    expect(creates).toHaveLength(2)
    expect(createFields(creates[0]).issuetype).toEqual({ name: "Sub-task" })
    expect(createFields(creates[1]).issuetype).toEqual({ name: "Bug" })
    expect(createFields(creates[1]).parent).toBeUndefined()
    expect(lastIssueLink()).toBeDefined()
    expect(created?.parentIssueKey).toBe("ABC-7")
  })

  it("keeps the parent field while retrying a sub-task create without rejected optionals", async () => {
    state.parentIssueType = { name: "Story", subtask: false, hierarchyLevel: 0 }
    state.createResponses = [
      { status: 400, body: { errors: { parent: "nope", priority: "nope" } } },
    ]
    const created = await createJiraIssue("br_abc123", {
      parentIssueRef: "ABC-7",
    })
    const creates = issueCreates()
    expect(creates).toHaveLength(2)
    // `priority` is droppable, `parent` is not: the retry is still a
    // sub-task under the parent, never a parentless one.
    const retry = createFields(creates[1])
    expect(retry.issuetype).toEqual({ name: "Sub-task" })
    expect(retry.parent).toEqual({ key: "ABC-7" })
    expect(retry.priority).toBeUndefined()
    expect(created?.parentIssueKey).toBe("ABC-7")
  })

  it("falls back to a Bug when the sub-task create is rejected only on parent", async () => {
    state.parentIssueType = { name: "Story", subtask: false, hierarchyLevel: 0 }
    state.createResponses = [
      { status: 400, body: { errors: { parent: "nope" } } },
    ]
    const created = await createJiraIssue("br_abc123", {
      parentIssueRef: "ABC-7",
    })
    const creates = issueCreates()
    expect(creates).toHaveLength(2)
    expect(createFields(creates[1]).issuetype).toEqual({ name: "Bug" })
    expect(createFields(creates[1]).parent).toBeUndefined()
    expect(lastIssueLink()).toBeDefined()
    expect(created?.parentIssueKey).toBe("ABC-7")
  })

  it("ignores GitHub-form parent refs without reporting an error", async () => {
    const created = await createJiraIssue("br_abc123", {
      parentIssueRef: "#123",
    })
    expect(createFields(lastIssueCreate()).parent).toBeUndefined()
    expect(created?.parentIssueKey).toBeNull()
    expect(state.nonFatalErrors).toHaveLength(0)
  })
})

describe("attachAndUpdateJiraIssue", () => {
  beforeEach(() => {
    state.report = makeReport()
    state.credentials = makeCredentials()
    state.captureBytes = Buffer.from("png-bytes")
    state.debuggerBytes = Buffer.from('{"logs":[]}')
  })

  it("uploads each artifact as a multipart attachment with the XSRF bypass header", async () => {
    await attachAndUpdateJiraIssue({
      bugReportId: "br_abc123",
      issueKey: "ABC-42",
      credentials: makeCredentials(),
    })
    const posts = attachmentPosts()
    expect(posts).toHaveLength(2)
    expect(posts[0].url).toBe(
      "https://acme.atlassian.net/rest/api/2/issue/ABC-42/attachments"
    )
    expect(posts[0].headers["X-Atlassian-Token"]).toBe("no-check")
    expect(posts[0].formFilenames).toEqual(["br_abc123.png"])
    expect(posts[1].formFilenames).toEqual(["br_abc123.debugger.json"])
  })

  it("rewrites the description with attachment links and an inline screenshot preview", async () => {
    await attachAndUpdateJiraIssue({
      bugReportId: "br_abc123",
      issueKey: "ABC-42",
      credentials: makeCredentials(),
    })
    const description = updatedDescription()
    expect(lastIssueUpdate()?.url).toBe(
      "https://acme.atlassian.net/rest/api/2/issue/ABC-42"
    )
    expect(description).toContain("h2. Artifacts")
    expect(description).toContain("* *Screenshot* — [^br_abc123.png]")
    expect(description).toContain("!br_abc123.png|thumbnail!")
    expect(description).toContain(
      "* *Debugger payload* — [^br_abc123.debugger.json]"
    )
  })

  it("does not inline-preview video recordings", async () => {
    state.report = makeReport({ attachmentType: "video" })
    await attachAndUpdateJiraIssue({
      bugReportId: "br_abc123",
      issueKey: "ABC-42",
      credentials: makeCredentials(),
    })
    const description = updatedDescription()
    expect(description).toContain("* *Recording* — [^br_abc123.webm]")
    expect(description).not.toContain("|thumbnail!")
  })

  it("skips oversize artifacts and renders a size notice instead", async () => {
    state.captureBytes = Buffer.alloc(41 * 1024 * 1024)
    await attachAndUpdateJiraIssue({
      bugReportId: "br_abc123",
      issueKey: "ABC-42",
      credentials: makeCredentials(),
    })
    expect(attachmentPosts().map((p) => p.formFilenames?.[0])).toEqual([
      "br_abc123.debugger.json",
    ])
    expect(updatedDescription()).toContain(
      "*Screenshot* — not uploaded (41.0 MB exceeds the 40 MB per-file limit)"
    )
  })

  it("renders an upload-failed notice when Jira rejects the attachment", async () => {
    state.attachmentStatus = 413
    await attachAndUpdateJiraIssue({
      bugReportId: "br_abc123",
      issueKey: "ABC-42",
      credentials: makeCredentials(),
    })
    expect(updatedDescription()).toContain("*Screenshot* — upload failed (")
  })

  it("reports a non-fatal error and does not throw when the PUT fails", async () => {
    state.updateStatus = 403
    await attachAndUpdateJiraIssue({
      bugReportId: "br_abc123",
      issueKey: "ABC-42",
      credentials: makeCredentials(),
    })
    expect(
      state.nonFatalErrors.some((e) => UPDATE_FAILED_RE.test(e.message))
    ).toBe(true)
  })
})

describe("forwardBugReportToJira", () => {
  it("creates the issue, uploads attachments, and rewrites the description", async () => {
    state.report = makeReport()
    state.credentials = makeCredentials()
    state.captureBytes = Buffer.from("png-bytes")
    state.debuggerBytes = Buffer.from("{}")
    await forwardBugReportToJira("br_abc123")
    expect(issueCreates()).toHaveLength(1)
    expect(attachmentPosts()).toHaveLength(2)
    expect(lastIssueUpdate()).toBeDefined()
  })
})
