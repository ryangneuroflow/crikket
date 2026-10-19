"use client"

import { Button } from "@crikket/ui/components/ui/button"
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@crikket/ui/components/ui/field"
import { Input } from "@crikket/ui/components/ui/input"
import { Textarea } from "@crikket/ui/components/ui/textarea"
import { useForm } from "@tanstack/react-form"
import { useRouter } from "nextjs-toploader/app"
import { useState } from "react"
import { toast } from "sonner"

import { jiraIntegrationFormSchema } from "@/lib/schema/settings"
import { client } from "@/utils/orpc"

import { getRequestErrorMessage } from "../_lib/get-request-error-message"

interface JiraIntegrationFormProps {
  initialConfigured: boolean
  initialSiteUrl: string | null
  initialEmail: string | null
  initialProjectKey: string | null
  initialIssueType: string | null
  initialSubtaskIssueType: string | null
  initialExtraFieldsJson: string | null
}

export function JiraIntegrationForm({
  initialConfigured,
  initialSiteUrl,
  initialEmail,
  initialProjectKey,
  initialIssueType,
  initialSubtaskIssueType,
  initialExtraFieldsJson,
}: JiraIntegrationFormProps) {
  const router = useRouter()
  const [configured, setConfigured] = useState(initialConfigured)
  const [isRemoving, setIsRemoving] = useState(false)

  const form = useForm({
    defaultValues: {
      siteUrl: initialSiteUrl ?? "",
      email: initialEmail ?? "",
      projectKey: initialProjectKey ?? "",
      issueType: initialIssueType ?? "Bug",
      subtaskIssueType: initialSubtaskIssueType ?? "",
      apiToken: "",
      extraFieldsJson: initialExtraFieldsJson ?? "",
    },
    validators: {
      onChange: jiraIntegrationFormSchema,
    },
    onSubmit: async ({ value }) => {
      if (!configured && value.apiToken.trim().length === 0) {
        toast.error("A Jira API token is required the first time.")
        return
      }
      try {
        const result = await client.jiraIntegration.upsert({
          siteUrl: value.siteUrl.trim(),
          email: value.email.trim(),
          projectKey: value.projectKey.trim(),
          issueType: value.issueType.trim() || undefined,
          subtaskIssueType: value.subtaskIssueType.trim(),
          apiToken:
            value.apiToken.trim().length > 0
              ? value.apiToken.trim()
              : undefined,
          extraFieldsJson: value.extraFieldsJson.trim(),
        })
        setConfigured(result.configured)
        toast.success("Jira integration saved")
        // Clear the token field after a successful save so the user can re-enter
        // a different token later without triggering "empty = keep existing" confusion.
        form.setFieldValue("apiToken", "")
        router.refresh()
      } catch (error) {
        toast.error(getRequestErrorMessage(error))
      }
    },
  })

  async function handleRemove() {
    // biome-ignore lint/suspicious/noAlert: browser confirm is adequate for this destructive admin action; a styled AlertDialog is a follow-up.
    const ok = window.confirm(
      "Remove the Jira integration? New bug reports will stop forwarding to the project."
    )
    if (!ok) {
      return
    }
    setIsRemoving(true)
    try {
      await client.jiraIntegration.remove()
      setConfigured(false)
      form.reset({
        siteUrl: "",
        email: "",
        projectKey: "",
        issueType: "Bug",
        subtaskIssueType: "",
        apiToken: "",
        extraFieldsJson: "",
      })
      toast.success("Jira integration removed")
      router.refresh()
    } catch (error) {
      toast.error(getRequestErrorMessage(error))
    } finally {
      setIsRemoving(false)
    }
  }

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault()
        event.stopPropagation()
        form.handleSubmit()
      }}
    >
      <form.Field name="siteUrl">
        {(field) => {
          const isInvalid =
            field.state.meta.isTouched && field.state.meta.errors.length > 0

          return (
            <Field data-invalid={isInvalid}>
              <FieldLabel htmlFor={field.name}>Jira site URL</FieldLabel>
              <Input
                aria-invalid={isInvalid}
                autoComplete="off"
                id={field.name}
                name={field.name}
                onBlur={field.handleBlur}
                onChange={(event) => field.handleChange(event.target.value)}
                placeholder="https://your-team.atlassian.net"
                value={field.state.value}
              />
              <FieldDescription>
                The base URL of your Jira Cloud site or Data Center install.
              </FieldDescription>
              {isInvalid ? (
                <FieldError errors={field.state.meta.errors} />
              ) : null}
            </Field>
          )
        }}
      </form.Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <form.Field name="projectKey">
          {(field) => {
            const isInvalid =
              field.state.meta.isTouched && field.state.meta.errors.length > 0

            return (
              <Field data-invalid={isInvalid}>
                <FieldLabel htmlFor={field.name}>Project key</FieldLabel>
                <Input
                  aria-invalid={isInvalid}
                  autoComplete="off"
                  id={field.name}
                  name={field.name}
                  onBlur={field.handleBlur}
                  onChange={(event) => field.handleChange(event.target.value)}
                  placeholder="ABC"
                  value={field.state.value}
                />
                <FieldDescription>
                  The prefix of the project's issue keys (e.g. <code>ABC</code>{" "}
                  for <code>ABC-123</code>).
                </FieldDescription>
                {isInvalid ? (
                  <FieldError errors={field.state.meta.errors} />
                ) : null}
              </Field>
            )
          }}
        </form.Field>

        <form.Field name="issueType">
          {(field) => {
            const isInvalid =
              field.state.meta.isTouched && field.state.meta.errors.length > 0

            return (
              <Field data-invalid={isInvalid}>
                <FieldLabel htmlFor={field.name}>Issue type</FieldLabel>
                <Input
                  aria-invalid={isInvalid}
                  autoComplete="off"
                  id={field.name}
                  name={field.name}
                  onBlur={field.handleBlur}
                  onChange={(event) => field.handleChange(event.target.value)}
                  placeholder="Bug"
                  value={field.state.value}
                />
                <FieldDescription>
                  Must match an issue type name in the project.
                </FieldDescription>
                {isInvalid ? (
                  <FieldError errors={field.state.meta.errors} />
                ) : null}
              </Field>
            )
          }}
        </form.Field>
      </div>

      <form.Field name="subtaskIssueType">
        {(field) => {
          const isInvalid =
            field.state.meta.isTouched && field.state.meta.errors.length > 0

          return (
            <Field data-invalid={isInvalid}>
              <FieldLabel htmlFor={field.name}>
                Sub-task issue type (optional)
              </FieldLabel>
              <Input
                aria-invalid={isInvalid}
                autoComplete="off"
                id={field.name}
                name={field.name}
                onBlur={field.handleBlur}
                onChange={(event) => field.handleChange(event.target.value)}
                placeholder="Auto-detect (e.g. Sub-task)"
                value={field.state.value}
              />
              <FieldDescription>
                Used when a reporter links a parent that can't hold a{" "}
                <code>Bug</code> (a Story or Task): the report is created as
                this sub-task type under that parent. Leave blank to use the
                project's first sub-task type.
              </FieldDescription>
              {isInvalid ? (
                <FieldError errors={field.state.meta.errors} />
              ) : null}
            </Field>
          )
        }}
      </form.Field>

      <form.Field name="email">
        {(field) => {
          const isInvalid =
            field.state.meta.isTouched && field.state.meta.errors.length > 0

          return (
            <Field data-invalid={isInvalid}>
              <FieldLabel htmlFor={field.name}>
                Atlassian account email
              </FieldLabel>
              <Input
                aria-invalid={isInvalid}
                autoComplete="off"
                id={field.name}
                name={field.name}
                onBlur={field.handleBlur}
                onChange={(event) => field.handleChange(event.target.value)}
                placeholder="you@example.com"
                type="email"
                value={field.state.value}
              />
              <FieldDescription>
                The account the API token belongs to. Issues are created as this
                user.
              </FieldDescription>
              {isInvalid ? (
                <FieldError errors={field.state.meta.errors} />
              ) : null}
            </Field>
          )
        }}
      </form.Field>

      <form.Field name="apiToken">
        {(field) => {
          const isInvalid =
            field.state.meta.isTouched && field.state.meta.errors.length > 0

          return (
            <Field data-invalid={isInvalid}>
              <FieldLabel htmlFor={field.name}>API token</FieldLabel>
              <Input
                aria-invalid={isInvalid}
                autoComplete="off"
                id={field.name}
                name={field.name}
                onBlur={field.handleBlur}
                onChange={(event) => field.handleChange(event.target.value)}
                placeholder={
                  configured
                    ? "•••••••• — leave empty to keep the stored token"
                    : "ATATT3..."
                }
                type="password"
                value={field.state.value}
              />
              <FieldDescription>
                Create one at{" "}
                <a
                  className="underline underline-offset-2 hover:no-underline"
                  href="https://id.atlassian.com/manage-profile/security/api-tokens"
                  rel="noopener noreferrer"
                  target="_blank"
                >
                  id.atlassian.com
                </a>
                . The account needs <strong>Create Issues</strong> permission in
                the project. Tokens are encrypted at rest.
              </FieldDescription>
              {isInvalid ? (
                <FieldError errors={field.state.meta.errors} />
              ) : null}
            </Field>
          )
        }}
      </form.Field>

      <form.Field name="extraFieldsJson">
        {(field) => {
          const isInvalid =
            field.state.meta.isTouched && field.state.meta.errors.length > 0

          return (
            <Field data-invalid={isInvalid}>
              <FieldLabel htmlFor={field.name}>
                Additional fields (optional)
              </FieldLabel>
              <Textarea
                aria-invalid={isInvalid}
                className="font-mono text-xs"
                id={field.name}
                name={field.name}
                onBlur={field.handleBlur}
                onChange={(event) => field.handleChange(event.target.value)}
                placeholder={
                  '{"customfield_10001": {"id": "10042"}, "components": [{"name": "Web"}]}'
                }
                rows={4}
                value={field.state.value}
              />
              <FieldDescription>
                JSON merged into the create-issue <code>fields</code> payload.
                Required custom fields are also shown to reporters in the
                capture widget, with these values pre-selected; listing an
                optional field here adds it to the widget too. Find field ids
                and option ids via{" "}
                <code>
                  /rest/api/2/issue/createmeta?projectKeys=KEY&amp;expand=projects.issuetypes.fields
                </code>
                .
              </FieldDescription>
              {isInvalid ? (
                <FieldError errors={field.state.meta.errors} />
              ) : null}
            </Field>
          )
        }}
      </form.Field>

      <div className="flex items-center gap-3">
        <Button disabled={form.state.isSubmitting} type="submit">
          {form.state.isSubmitting
            ? "Saving..."
            : configured
              ? "Update integration"
              : "Save integration"}
        </Button>
        {configured ? (
          <Button
            disabled={isRemoving || form.state.isSubmitting}
            onClick={handleRemove}
            type="button"
            variant="ghost"
          >
            {isRemoving ? "Removing..." : "Remove integration"}
          </Button>
        ) : null}
      </div>
    </form>
  )
}
