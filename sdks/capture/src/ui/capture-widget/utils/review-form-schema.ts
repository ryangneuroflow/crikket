import {
  BUG_REPORT_VISIBILITY_OPTIONS,
  type BugReportVisibility,
} from "@crikket/shared/constants/bug-report"
import {
  PRIORITY_OPTIONS,
  type Priority,
} from "@crikket/shared/constants/priorities"
import type { CaptureSubmissionDraft } from "../../../types"

const priorityValues = new Set<string>(Object.values(PRIORITY_OPTIONS))
const visibilityValues = new Set<string>(
  Object.values(BUG_REPORT_VISIBILITY_OPTIONS)
)

// Client-side sanity check — the server owns the canonical parse in
// `parseParentIssueRef` (packages/bug-reports/src/lib/integrations.ts).
// Catching obvious typos here keeps the reporter in the form flow.
const PARENT_ISSUE_PATTERN =
  /^(https?:\/\/(?:www\.)?github\.com\/[^/\s]+\/[^/\s]+\/issues\/\d+(?:[/?#].*)?|#?\d+)$/i
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
  value: CaptureSubmissionDraft
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

  const parentRef = value.parentIssueRef?.trim() ?? ""
  if (parentRef.length > MAX_PARENT_ISSUE_REF_LENGTH) {
    errors.parentIssueRef = "Parent issue reference is too long."
  } else if (parentRef !== "" && !PARENT_ISSUE_PATTERN.test(parentRef)) {
    errors.parentIssueRef = "Enter a GitHub issue URL, #<number>, or <number>."
  }

  return Object.keys(errors).length > 0 ? errors : undefined
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
  }
}

export type CapturePriority = Priority
