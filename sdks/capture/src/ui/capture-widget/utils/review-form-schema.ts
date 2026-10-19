import {
  BUG_REPORT_VISIBILITY_OPTIONS,
  type BugReportVisibility,
} from "@crikket/shared/constants/bug-report"
import {
  PRIORITY_OPTIONS,
  type Priority,
} from "@crikket/shared/constants/priorities"
import type { CaptureSubmissionDraft, JiraReporterField } from "../../../types"

const priorityValues = new Set<string>(Object.values(PRIORITY_OPTIONS))
const visibilityValues = new Set<string>(
  Object.values(BUG_REPORT_VISIBILITY_OPTIONS)
)

// Client-side sanity check — the server owns the canonical parse in
// `parseParentIssueRef` (packages/bug-reports/src/lib/integrations.ts) and
// `parseJiraParentIssueRef` (packages/bug-reports/src/lib/jira-integration.ts).
// Catching obvious typos here keeps the reporter in the form flow.
const GITHUB_PARENT_PATTERN =
  /^(https?:\/\/(?:www\.)?github\.com\/[^/\s]+\/[^/\s]+\/issues\/\d+(?:[/?#].*)?|#?\d+)$/i
const JIRA_PARENT_PATTERN =
  /^([a-z][a-z0-9_]*-\d+|https?:\/\/[^/\s]+(?:\/[^\s?#]*)?\/browse\/[a-z][a-z0-9_]*-\d+(?:[/?#].*)?)$/i
const MAX_PARENT_ISSUE_REF_LENGTH = 500
export type ReviewDraftErrors = Partial<
  Record<keyof CaptureSubmissionDraft, string>
>

export const capturePriorityOptions = [
  { label: "Critical", value: PRIORITY_OPTIONS.critical },
  { label: "High", value: PRIORITY_OPTIONS.high },
  { label: "Medium", value: PRIORITY_OPTIONS.medium },
  { label: "Low", value: PRIORITY_OPTIONS.low },
  { label: "None", value: PRIORITY_OPTIONS.none },
] as const

export function validateReviewDraft(
  value: CaptureSubmissionDraft,
  options?: { jiraFields?: JiraReporterField[] }
): ReviewDraftErrors | undefined {
  const errors: ReviewDraftErrors = {}

  if (value.title.length > 200) {
    errors.title = "Title must be at most 200 characters."
  }

  if (value.description.length > 3000) {
    errors.description = "Description must be at most 3000 characters."
  }

  if (!priorityValues.has(value.priority)) {
    errors.priority = "Select a valid priority."
  }

  if (
    value.visibility !== undefined &&
    !visibilityValues.has(value.visibility)
  ) {
    errors.visibility = "Select a valid visibility."
  }

  // Jira's required fields only matter when the report is going to Jira.
  if (value.forwardTarget === "jira") {
    const jiraError = validateJiraFieldValues(
      value.jiraFields ?? {},
      options?.jiraFields ?? []
    )
    if (jiraError) {
      errors.jiraFields = jiraError
    }
  }

  const parentRef = value.parentIssueRef?.trim() ?? ""
  if (parentRef.length > MAX_PARENT_ISSUE_REF_LENGTH) {
    errors.parentIssueRef = "Parent issue reference is too long."
  } else if (parentRef !== "") {
    const parentError = validateParentIssueRef(parentRef, value.forwardTarget)
    if (parentError) {
      errors.parentIssueRef = parentError
    }
  }

  return Object.keys(errors).length > 0 ? errors : undefined
}

function validateParentIssueRef(
  ref: string,
  target: CaptureSubmissionDraft["forwardTarget"]
): string | undefined {
  if (target === "github") {
    return GITHUB_PARENT_PATTERN.test(ref)
      ? undefined
      : "Enter a GitHub issue URL, #<number>, or <number>."
  }
  if (target === "jira") {
    return JIRA_PARENT_PATTERN.test(ref)
      ? undefined
      : "Enter a Jira key like ABC-123 or an issue URL."
  }
  return GITHUB_PARENT_PATTERN.test(ref) || JIRA_PARENT_PATTERN.test(ref)
    ? undefined
    : "Enter a GitHub issue URL or #<number>, or a Jira key like ABC-123."
}

// Every required Jira field needs a value; option fields must point at one
// of the served options so the server's re-validation can't silently drop
// a value the reporter thought they'd set.
export function validateJiraFieldValues(
  values: Record<string, unknown>,
  fields: JiraReporterField[]
): string | undefined {
  for (const field of fields) {
    const value = values[field.id]
    if (isEmptyJiraValue(value)) {
      if (field.required) {
        return `${field.name} is required.`
      }
      continue
    }
    if (
      (field.type === "select" || field.type === "multiselect") &&
      !hasKnownOptions(field, value)
    ) {
      return `Select a valid ${field.name}.`
    }
  }
  return undefined
}

export function isEmptyJiraValue(value: unknown): boolean {
  if (value === undefined || value === null || value === "") return true
  return Array.isArray(value) && value.length === 0
}

function hasKnownOptions(field: JiraReporterField, value: unknown): boolean {
  const ids = (Array.isArray(value) ? value : [value]).map((item) =>
    typeof item === "object" && item !== null && "id" in item
      ? (item as { id: unknown }).id
      : item
  )
  return ids.every((id) => field.options?.some((option) => option.id === id))
}

export function trimReviewDraftForSubmission(
  draft: CaptureSubmissionDraft
): CaptureSubmissionDraft {
  const trimmedParentRef = draft.parentIssueRef?.trim() ?? ""
  return {
    description: draft.description.trim(),
    priority: draft.priority,
    title: draft.title.trim(),
    visibility: visibilityValues.has(draft.visibility ?? "")
      ? (draft.visibility as BugReportVisibility)
      : BUG_REPORT_VISIBILITY_OPTIONS.private,
    parentIssueRef: trimmedParentRef === "" ? undefined : trimmedParentRef,
    // Jira values are meaningless on a GitHub-bound report; don't send them.
    jiraFields:
      draft.forwardTarget === "jira"
        ? stripEmptyJiraValues(draft.jiraFields)
        : undefined,
    forwardTarget: draft.forwardTarget,
  }
}

function stripEmptyJiraValues(
  values: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!values) return undefined
  const kept = Object.entries(values).filter(
    ([, value]) => !isEmptyJiraValue(value)
  )
  return kept.length > 0 ? Object.fromEntries(kept) : undefined
}

export type CapturePriority = Priority
