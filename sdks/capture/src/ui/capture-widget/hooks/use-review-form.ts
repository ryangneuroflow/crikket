import { useEffect, useMemo, useState } from "react"
import type {
  CaptureIntegrations,
  CaptureSubmissionDraft,
} from "../../../types"
import { defaultForwardTarget } from "../../store/capture-ui-store"
import type { ReviewDraftErrors } from "../utils/review-form-schema"
import {
  trimReviewDraftForSubmission,
  validateReviewDraft,
} from "../utils/review-form-schema"

type ReviewDraftField = keyof CaptureSubmissionDraft
type ReviewDraftTouched = Record<ReviewDraftField, boolean>

const INITIAL_TOUCHED_STATE: ReviewDraftTouched = {
  description: false,
  priority: false,
  title: false,
  visibility: false,
  parentIssueRef: false,
  jiraFields: false,
  forwardTarget: false,
}

export function useReviewForm(input: {
  initialDraft: CaptureSubmissionDraft
  integrations: CaptureIntegrations | null
  onSubmit: (draft: CaptureSubmissionDraft) => Promise<void> | void
}): {
  draft: CaptureSubmissionDraft
  visibleErrors: ReviewDraftErrors
  setFieldValue: <TField extends ReviewDraftField>(
    field: TField,
    value: CaptureSubmissionDraft[TField]
  ) => void
  touchField: (field: ReviewDraftField) => void
  handleSubmit: (event: React.FormEvent<HTMLFormElement>) => void
} {
  const [draft, setDraft] = useState(input.initialDraft)
  const [touched, setTouched] = useState(INITIAL_TOUCHED_STATE)
  const { integrations } = input
  const jiraFields = integrations?.jira.fields ?? []

  // Integrations arrive asynchronously after the form mounts. Pick the
  // default tracker if the reporter hasn't chosen one, and seed the admin
  // defaults for any Jira field they haven't touched, without clobbering
  // values they already picked.
  useEffect(() => {
    if (!integrations) {
      return
    }
    setDraft((currentDraft) => {
      let changed = false
      const next = { ...currentDraft }
      if (currentDraft.forwardTarget === undefined) {
        const target = defaultForwardTarget(integrations)
        if (target !== undefined) {
          next.forwardTarget = target
          changed = true
        }
      }
      const current = currentDraft.jiraFields ?? {}
      const seeded = { ...current }
      for (const field of integrations.jira.fields) {
        if (field.defaultValue !== undefined && !(field.id in current)) {
          seeded[field.id] = field.defaultValue
          changed = true
        }
      }
      next.jiraFields = seeded
      return changed ? next : currentDraft
    })
  }, [integrations])

  const errors = useMemo(() => {
    return validateReviewDraft(draft, { jiraFields }) ?? {}
  }, [draft, jiraFields])

  const visibleErrors = useMemo(() => {
    const nextVisibleErrors: ReviewDraftErrors = {}

    for (const field of Object.keys(touched) as ReviewDraftField[]) {
      if (touched[field] && errors[field]) {
        nextVisibleErrors[field] = errors[field]
      }
    }

    return nextVisibleErrors
  }, [errors, touched])

  const setFieldValue = <TField extends ReviewDraftField>(
    field: TField,
    value: CaptureSubmissionDraft[TField]
  ): void => {
    setDraft((currentDraft) => ({
      ...currentDraft,
      [field]: value,
    }))
  }

  const touchField = (field: ReviewDraftField): void => {
    setTouched((currentTouched) => {
      if (currentTouched[field]) {
        return currentTouched
      }

      return {
        ...currentTouched,
        [field]: true,
      }
    })
  }

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    event.stopPropagation()

    setTouched({
      description: true,
      priority: true,
      title: true,
      visibility: true,
      parentIssueRef: true,
      jiraFields: true,
      forwardTarget: true,
    })

    const submitErrors = validateReviewDraft(draft, { jiraFields })
    if (submitErrors) {
      return
    }

    input.onSubmit(trimReviewDraftForSubmission(draft))
  }

  return {
    draft,
    handleSubmit,
    setFieldValue,
    touchField,
    visibleErrors,
  }
}
