import { useEffect, useRef, useState } from "react"
import type { CaptureSubmissionDraft } from "../../../types"
import type { CaptureReviewSubmitOptions, CaptureUiState } from "../../types"
import { MediaPreview } from "../components/media-preview"
import { Button } from "../components/primitives/button"
import { Field, FieldError } from "../components/primitives/field"
import { Input } from "../components/primitives/input"
import { Label } from "../components/primitives/label"
import { Textarea } from "../components/primitives/textarea"
import { ScreenshotAnnotationEditor } from "../components/screenshot-annotation-editor"
import { SummaryStat } from "../components/summary-stat"
import { useReviewForm } from "../hooks/use-review-form"
import { capturePriorityOptions } from "../utils/review-form-schema"
import {
  createAnnotatedScreenshotBlob,
  type ScreenshotAnnotation,
} from "../utils/screenshot-annotations"

interface ReviewFormSectionProps {
  formKey: string
  isSubmitting: boolean
  state: CaptureUiState
  onCancel: () => void
  onSubmit: (
    draft: CaptureSubmissionDraft,
    options?: CaptureReviewSubmitOptions
  ) => Promise<void>
}

export function ReviewFormSection({
  formKey,
  isSubmitting,
  state,
  onCancel,
  onSubmit,
}: ReviewFormSectionProps): React.JSX.Element {
  const [annotations, setAnnotations] = useState<ScreenshotAnnotation[]>([])
  const previousMediaObjectUrlRef = useRef(state.media?.objectUrl)

  useEffect(() => {
    if (previousMediaObjectUrlRef.current === state.media?.objectUrl) {
      return
    }

    previousMediaObjectUrlRef.current = state.media?.objectUrl
    setAnnotations([])
  }, [state.media?.objectUrl])

  const form = useReviewForm({
    initialDraft: state.reviewDraft,
    onSubmit: async (draft) => {
      let submitOptions: CaptureReviewSubmitOptions | undefined

      if (state.media?.captureType === "screenshot" && annotations.length > 0) {
        const screenshotBlobOverride = await createAnnotatedScreenshotBlob({
          annotations,
          imageUrl: state.media.objectUrl,
        })

        submitOptions = screenshotBlobOverride
          ? { screenshotBlobOverride }
          : undefined
      }

      onSubmit(draft, submitOptions)
    },
  })

  return (
    <section
      className="grid h-full min-h-0 gap-0 lg:grid-cols-[minmax(0,1.5fr)_360px]"
      key={formKey}
    >
      <div className="flex min-h-[320px] min-w-0 flex-col border-b bg-muted/20 lg:border-r lg:border-b-0">
        <div className="flex items-center justify-between gap-3 border-b px-5 py-4">
          <div>
            <p className="font-medium text-sm">Review capture</p>
            <p className="text-muted-foreground text-xs">
              {state.media?.captureType === "screenshot"
                ? "Annotate the screenshot before submitting."
                : "Preview the recording before submitting."}
            </p>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-auto p-5">
          {state.media?.captureType === "screenshot" ? (
            <ScreenshotAnnotationEditor
              annotations={annotations}
              disabled={state.busy || isSubmitting}
              onChange={setAnnotations}
              src={state.media.objectUrl}
            />
          ) : (
            <div className="flex min-h-full items-center justify-center">
              <div className="aspect-video w-full overflow-hidden rounded-xl border border-border/70 bg-black">
                <MediaPreview media={state.media} />
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="min-h-0 overflow-y-auto p-5">
        <div className="grid gap-4">
          <div className="grid grid-cols-3 gap-2">
            <SummaryStat label="Actions" value={state.summary.actions} />
            <SummaryStat label="Logs" value={state.summary.logs} />
            <SummaryStat
              label="Network"
              value={state.summary.networkRequests}
            />
          </div>

          {state.warnings.length > 0 ? (
            <ul className="m-0 grid gap-1 rounded-lg border bg-muted/40 px-4 py-3 pl-8 text-muted-foreground text-xs">
              {state.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          ) : null}

          <form className="grid gap-4" onSubmit={form.handleSubmit}>
            <Field data-invalid={Boolean(form.visibleErrors.title)}>
              <Label htmlFor={`${formKey}-title`}>Title</Label>
              <Input
                aria-invalid={Boolean(form.visibleErrors.title)}
                id={`${formKey}-title`}
                maxLength={200}
                onBlur={() => {
                  form.touchField("title")
                }}
                onChange={(event) => {
                  form.setFieldValue("title", event.currentTarget.value)
                }}
                placeholder="Enter a title (optional)"
                value={form.draft.title}
              />
              {form.visibleErrors.title ? (
                <FieldError errors={[form.visibleErrors.title]} />
              ) : null}
            </Field>

            <Field data-invalid={Boolean(form.visibleErrors.description)}>
              <Label htmlFor={`${formKey}-description`}>Description</Label>
              <Textarea
                aria-invalid={Boolean(form.visibleErrors.description)}
                className="min-h-32 resize-y"
                id={`${formKey}-description`}
                maxLength={4000}
                onBlur={() => {
                  form.touchField("description")
                }}
                onChange={(event) => {
                  form.setFieldValue("description", event.currentTarget.value)
                }}
                placeholder="Enter a description (optional)"
                value={form.draft.description}
              />
              {form.visibleErrors.description ? (
                <FieldError errors={[form.visibleErrors.description]} />
              ) : null}
            </Field>

            <Field data-invalid={Boolean(form.visibleErrors.priority)}>
              <Label htmlFor={`${formKey}-priority`}>Priority</Label>
              <select
                aria-invalid={Boolean(form.visibleErrors.priority)}
                className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none transition-[border-color,box-shadow] focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/60"
                id={`${formKey}-priority`}
                onBlur={() => {
                  form.touchField("priority")
                }}
                onChange={(event) => {
                  form.setFieldValue(
                    "priority",
                    event.currentTarget
                      .value as CaptureSubmissionDraft["priority"]
                  )
                }}
                value={form.draft.priority}
              >
                {capturePriorityOptions.map((priority) => (
                  <option key={priority.value} value={priority.value}>
                    {priority.label}
                  </option>
                ))}
              </select>
              {form.visibleErrors.priority ? (
                <FieldError errors={[form.visibleErrors.priority]} />
              ) : null}
            </Field>

            <Field data-invalid={Boolean(form.visibleErrors.parentIssueRef)}>
              <Label htmlFor={`${formKey}-parent-issue`}>
                Parent GitHub issue
              </Label>
              <Input
                aria-invalid={Boolean(form.visibleErrors.parentIssueRef)}
                id={`${formKey}-parent-issue`}
                maxLength={500}
                onBlur={() => {
                  form.touchField("parentIssueRef")
                }}
                onChange={(event) => {
                  form.setFieldValue(
                    "parentIssueRef",
                    event.currentTarget.value
                  )
                }}
                placeholder="https://github.com/owner/repo/issues/123 or #123"
                value={form.draft.parentIssueRef ?? ""}
              />
              <p className="text-muted-foreground text-xs">
                Link this report as a sub-issue of an existing GitHub issue.
                Leave blank to create a standalone issue.
              </p>
              {form.visibleErrors.parentIssueRef ? (
                <FieldError errors={[form.visibleErrors.parentIssueRef]} />
              ) : null}
            </Field>

            <div className="grid grid-cols-2 gap-2">
              <Button
                className="w-full"
                disabled={state.busy || isSubmitting}
                type="submit"
              >
                Submit Report
              </Button>
              <Button
                className="w-full"
                disabled={state.busy || isSubmitting}
                onClick={onCancel}
                type="button"
                variant="outline"
              >
                Start Over
              </Button>
            </div>
          </form>
        </div>
      </div>
    </section>
  )
}
