import type { JiraReporterField } from "../../../types"
import { Field, FieldError } from "../components/primitives/field"
import { Input } from "../components/primitives/input"
import { Label } from "../components/primitives/label"

const SELECT_CLASS_NAME =
  "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none transition-[border-color,box-shadow] focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/60"

/**
 * Project-specific Jira fields (required custom selects and the like) that
 * the host server asked the reporter to fill in. Values are stored in the
 * draft keyed by Jira field id, in the shape the create API expects.
 */
export function JiraFieldsSection(props: {
  error: string | undefined
  fields: JiraReporterField[]
  formKey: string
  onBlur: () => void
  onChange: (fieldId: string, value: unknown) => void
  values: Record<string, unknown>
}): React.JSX.Element {
  return (
    <fieldset className="m-0 grid gap-4 border-0 p-0">
      <legend className="mb-1 font-medium text-sm">Jira</legend>
      {props.fields.map((field) => {
        const inputId = `${props.formKey}-jira-${field.id}`
        const value = props.values[field.id]
        return (
          <Field key={field.id}>
            <Label htmlFor={inputId}>
              {field.name}
              {field.required ? (
                <span aria-hidden="true" className="text-destructive">
                  {" "}
                  *
                </span>
              ) : null}
            </Label>
            {renderControl({
              field,
              inputId,
              onBlur: props.onBlur,
              onChange: (next) => props.onChange(field.id, next),
              value,
            })}
          </Field>
        )
      })}
      {props.error ? <FieldError errors={[props.error]} /> : null}
    </fieldset>
  )
}

function renderControl(input: {
  field: JiraReporterField
  inputId: string
  onBlur: () => void
  onChange: (value: unknown) => void
  value: unknown
}): React.JSX.Element {
  const { field, inputId, onBlur, onChange, value } = input

  if (field.type === "select") {
    return (
      <select
        aria-required={field.required}
        className={SELECT_CLASS_NAME}
        id={inputId}
        onBlur={onBlur}
        onChange={(event) => {
          const id = event.currentTarget.value
          onChange(id ? { id } : undefined)
        }}
        value={optionIdOf(value) ?? ""}
      >
        <option value="">{field.required ? "Select…" : "None"}</option>
        {field.options?.map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
          </option>
        ))}
      </select>
    )
  }

  if (field.type === "multiselect") {
    const selected = new Set(
      (Array.isArray(value) ? value : [])
        .map(optionIdOf)
        .filter((id): id is string => Boolean(id))
    )
    return (
      <select
        aria-required={field.required}
        className={`${SELECT_CLASS_NAME} h-auto min-h-24 py-1`}
        id={inputId}
        multiple
        onBlur={onBlur}
        onChange={(event) => {
          const ids = Array.from(event.currentTarget.selectedOptions).map(
            (option) => option.value
          )
          onChange(ids.length > 0 ? ids.map((id) => ({ id })) : undefined)
        }}
        value={Array.from(selected)}
      >
        {field.options?.map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
          </option>
        ))}
      </select>
    )
  }

  return (
    <Input
      aria-required={field.required}
      id={inputId}
      inputMode={field.type === "number" ? "decimal" : undefined}
      maxLength={1000}
      onBlur={onBlur}
      onChange={(event) => {
        const raw = event.currentTarget.value
        if (field.type === "number") {
          onChange(raw === "" ? undefined : Number(raw))
          return
        }
        onChange(raw)
      }}
      type={field.type === "number" ? "number" : "text"}
      value={value === undefined || value === null ? "" : String(value)}
    />
  )
}

function optionIdOf(value: unknown): string | null {
  if (typeof value === "string") return value
  if (typeof value === "object" && value !== null && "id" in value) {
    const id = (value as { id: unknown }).id
    return typeof id === "string" ? id : null
  }
  return null
}
