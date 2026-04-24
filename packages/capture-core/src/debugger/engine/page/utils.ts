import { MAX_TEXT_LENGTH } from "./constants"
import type { Reporter } from "./types"

const REDACTED_VALUE = "[REDACTED]"
const SENSITIVE_NAME_PATTERNS = [
  "authorization",
  "cookie",
  "set-cookie",
  "token",
  "secret",
  "password",
  "passwd",
  "pwd",
  "session",
  "api-key",
  "apikey",
  "x-api-key",
  "refresh-token",
  "refresh_token",
  "access-token",
  "access_token",
  "id-token",
  "id_token",
  "client-secret",
  "client_secret",
] as const

const REDACTABLE_FIELD_PATTERN =
  /((?:access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|client[_-]?secret|password|passwd|pwd|authorization|cookie|session[_-]?id)\s*[:=]\s*)([^&\s",;]+)/gi

export const truncate = (
  value: string,
  maxLength = MAX_TEXT_LENGTH
): string => {
  if (value.length <= maxLength) {
    return value
  }

  return `${value.slice(0, maxLength)}...`
}

export const isSensitiveName = (value: string): boolean => {
  const normalizedValue = value.trim().toLowerCase()
  if (!normalizedValue) {
    return false
  }

  return SENSITIVE_NAME_PATTERNS.some((pattern) => {
    return normalizedValue.includes(pattern)
  })
}

export const shouldHideHeader = (headerName: string): boolean => {
  return headerName.includes("debugger") || isSensitiveName(headerName)
}

// Human- and agent-readable identifier for a clicked element, in priority
// order: [data-testid] → [aria-label] → visible text for interactive elements
// → #id → [name] on form controls → tag + non-utility class → tag.
//
// Rationale: for Tailwind-heavy apps, the old tag.firstClass output collapsed
// to utility names like `section.relative` or `a.font-medium`, which identify
// nothing. The priority above prefers intentional, stable signals first
// (testid/aria-label), then what a human sees on screen (visible text on
// buttons/links), before falling back to structural hints.
const MAX_TARGET_TEXT_LENGTH = 60

// Tailwind utility-class filter. A class is "utility-looking" if it is a
// variant-prefixed selector (e.g. `hover:bg-red-500`, `sm:flex`), a known
// standalone utility word, or begins with a known utility prefix. These never
// help a reader identify an element, so we skip past them when picking a class
// to include in the target string. The lists aren't exhaustive — the fallback
// is tag-only, which is strictly better than a misleading utility class.
const UTILITY_EXACT_CLASSES = new Set([
  "relative",
  "absolute",
  "fixed",
  "sticky",
  "static",
  "block",
  "inline",
  "inline-block",
  "inline-flex",
  "inline-grid",
  "flex",
  "grid",
  "hidden",
  "contents",
  "container",
  "italic",
  "not-italic",
  "uppercase",
  "lowercase",
  "capitalize",
  "underline",
  "line-through",
  "truncate",
  "antialiased",
  "visible",
  "invisible",
  "isolate",
  "sr-only",
  "not-sr-only",
  "border",
  "rounded",
  "shadow",
  "ring",
  "transform",
  "transition",
])

const UTILITY_CLASS_PREFIXES = [
  "p-",
  "px-",
  "py-",
  "pt-",
  "pb-",
  "pl-",
  "pr-",
  "m-",
  "mx-",
  "my-",
  "mt-",
  "mb-",
  "ml-",
  "mr-",
  "w-",
  "h-",
  "min-",
  "max-",
  "top-",
  "bottom-",
  "left-",
  "right-",
  "inset-",
  "z-",
  "gap-",
  "space-",
  "text-",
  "bg-",
  "font-",
  "border-",
  "rounded-",
  "shadow-",
  "opacity-",
  "cursor-",
  "overflow-",
  "items-",
  "justify-",
  "content-",
  "self-",
  "place-",
  "grid-",
  "col-",
  "row-",
  "flex-",
  "order-",
  "leading-",
  "tracking-",
  "indent-",
  "align-",
  "whitespace-",
  "list-",
  "decoration-",
  "divide-",
  "ring-",
  "pointer-events-",
  "select-",
  "resize-",
  "duration-",
  "ease-",
  "delay-",
  "animate-",
  "origin-",
  "scale-",
  "rotate-",
  "translate-",
  "skew-",
  "aspect-",
  "fill-",
  "stroke-",
  "from-",
  "to-",
  "via-",
]

const INTERACTIVE_TAGS = new Set(["button", "a", "summary", "label"])
const INTERACTIVE_ROLES = new Set([
  "button",
  "link",
  "menuitem",
  "tab",
  "checkbox",
  "radio",
  "switch",
  "option",
])
const INTERACTIVE_INPUT_TYPES = new Set([
  "button",
  "submit",
  "reset",
  "checkbox",
  "radio",
])
const NAMED_CONTROL_TAGS = new Set(["input", "select", "textarea"])

export const looksLikeUtilityClass = (cls: string): boolean => {
  if (cls.includes(":")) return true
  if (UTILITY_EXACT_CLASSES.has(cls)) return true
  return UTILITY_CLASS_PREFIXES.some((prefix) => cls.startsWith(prefix))
}

// Minimal structural view of an Element, broken out so tests can drive the
// logic without a full DOM (bun's runtime has no Element global).
export interface ElementLike {
  tagName: string
  id: string
  className: unknown
  textContent: string | null
  getAttribute: (name: string) => string | null
}

const shortTargetText = (value: string): string => {
  const collapsed = value.replace(/\s+/g, " ").trim()
  if (collapsed.length <= MAX_TARGET_TEXT_LENGTH) return collapsed
  return `${collapsed.slice(0, MAX_TARGET_TEXT_LENGTH)}…`
}

const escapeAttributeValue = (value: string): string => {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
}

const isInteractive = (element: ElementLike, tag: string): boolean => {
  if (INTERACTIVE_TAGS.has(tag)) return true
  if (tag === "input") {
    const type = element.getAttribute("type")?.toLowerCase() ?? ""
    if (INTERACTIVE_INPUT_TYPES.has(type)) return true
  }
  const role = element.getAttribute("role")?.toLowerCase() ?? ""
  return INTERACTIVE_ROLES.has(role)
}

export const describeElement = (element: ElementLike): string => {
  const tag = element.tagName.toLowerCase()

  const testId =
    element.getAttribute("data-testid") ??
    element.getAttribute("data-test-id") ??
    element.getAttribute("data-test")
  if (testId && testId.trim().length > 0) {
    return `[data-testid="${escapeAttributeValue(shortTargetText(testId))}"]`
  }

  const ariaLabel = element.getAttribute("aria-label")
  if (ariaLabel && ariaLabel.trim().length > 0) {
    return `${tag}[aria-label="${escapeAttributeValue(shortTargetText(ariaLabel))}"]`
  }

  if (isInteractive(element, tag)) {
    const text = shortTargetText(element.textContent ?? "")
    if (text.length > 0) {
      return `${tag} "${text}"`
    }
  }

  if (element.id) {
    return `#${element.id}`
  }

  if (NAMED_CONTROL_TAGS.has(tag)) {
    const nameAttr = element.getAttribute("name")
    if (nameAttr && nameAttr.trim().length > 0) {
      return `${tag}[name="${escapeAttributeValue(nameAttr.trim())}"]`
    }
  }

  const classNames =
    typeof element.className === "string" ? element.className : ""
  const meaningfulClass = classNames
    .split(" ")
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0 && !looksLikeUtilityClass(entry))
  if (meaningfulClass) {
    return `${tag}.${meaningfulClass}`
  }

  return tag
}

export const getElementTarget = (
  target: EventTarget | null
): string | undefined => {
  // `Element` isn't defined in non-browser runtimes (Bun/Node). Matches the
  // typeof guard the serializer already uses — keeps this callable from
  // SSR/tests without a ReferenceError.
  if (typeof Element === "undefined" || !(target instanceof Element)) {
    return undefined
  }

  return describeElement(target as unknown as ElementLike)
}

export const toAbsoluteUrl = (
  value: string,
  reporter: Reporter
): string | null => {
  try {
    return new URL(value, location.href).toString()
  } catch (error) {
    reporter.reportNonFatalError(
      "Failed to normalize network URL in debugger instrumentation",
      {
        error,
        value,
      }
    )
    return null
  }
}

export const redactSensitiveQueryParams = (absoluteUrl: string): string => {
  try {
    const parsedUrl = new URL(absoluteUrl)
    for (const [key] of parsedUrl.searchParams.entries()) {
      if (!isSensitiveName(key)) {
        continue
      }

      parsedUrl.searchParams.set(key, REDACTED_VALUE)
    }

    return parsedUrl.toString()
  } catch {
    return absoluteUrl
  }
}

const sanitizeStructuredValue = (value: unknown, depth = 0): unknown => {
  if (depth >= 6) {
    return "[MaxDepth]"
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeStructuredValue(item, depth + 1))
  }

  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {}
    for (const [key, nestedValue] of Object.entries(value)) {
      if (isSensitiveName(key)) {
        result[key] = REDACTED_VALUE
        continue
      }

      result[key] = sanitizeStructuredValue(nestedValue, depth + 1)
    }

    return result
  }

  if (typeof value === "string") {
    return value.replace(REDACTABLE_FIELD_PATTERN, `$1${REDACTED_VALUE}`)
  }

  return value
}

const sanitizeUrlEncodedBody = (body: string): string => {
  const params = new URLSearchParams(body)
  for (const [key] of params.entries()) {
    if (!isSensitiveName(key)) {
      continue
    }

    params.set(key, REDACTED_VALUE)
  }

  return params.toString()
}

export const sanitizeCapturedBody = (
  body: string | undefined,
  contentType: string
): string | undefined => {
  if (typeof body !== "string" || body.length === 0) {
    return body
  }

  const normalizedContentType = contentType.toLowerCase()
  if (normalizedContentType.includes("application/json")) {
    try {
      const parsed = JSON.parse(body) as unknown
      return truncate(
        JSON.stringify(sanitizeStructuredValue(parsed)),
        MAX_TEXT_LENGTH * 2
      )
    } catch {
      return truncate(
        body.replace(REDACTABLE_FIELD_PATTERN, `$1${REDACTED_VALUE}`),
        MAX_TEXT_LENGTH * 2
      )
    }
  }

  if (normalizedContentType.includes("x-www-form-urlencoded")) {
    return truncate(sanitizeUrlEncodedBody(body), MAX_TEXT_LENGTH * 2)
  }

  return truncate(
    body.replace(REDACTABLE_FIELD_PATTERN, `$1${REDACTED_VALUE}`),
    MAX_TEXT_LENGTH * 2
  )
}

export function createNonFatalReporter(): Reporter {
  const originalConsoleWarn = console.warn.bind(console)
  const reportedContexts = new Set<string>()

  return {
    reportNonFatalError(context, error) {
      if (reportedContexts.has(context)) {
        return
      }

      reportedContexts.add(context)
      originalConsoleWarn(`[Non-fatal] ${context}`, error)
    },
  }
}
