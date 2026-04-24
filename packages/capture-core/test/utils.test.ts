import { describe, expect, it } from "bun:test"

import {
  describeElement,
  type ElementLike,
  getElementTarget,
  looksLikeUtilityClass,
} from "../src/debugger/engine/page/utils"

// The production `getElementTarget` wraps an `instanceof Element` guard around
// `describeElement`. Bun's test runtime has no DOM globals, so the tests drive
// `describeElement` directly with duck-typed fixtures — same code path minus
// the Element guard, which is covered separately below.

function makeElement(overrides: Partial<ElementLike> = {}): ElementLike {
  const attrs = new Map<string, string>()
  return {
    tagName: "DIV",
    id: "",
    className: "",
    textContent: "",
    ...overrides,
    getAttribute: (name: string) => attrs.get(name) ?? null,
  }
}

function withAttrs(
  base: Partial<ElementLike>,
  attrs: Record<string, string>
): ElementLike {
  return {
    tagName: "DIV",
    id: "",
    className: "",
    textContent: "",
    ...base,
    getAttribute: (name: string) => attrs[name] ?? null,
  }
}

describe("describeElement: priority order", () => {
  it("prefers data-testid over every other signal", () => {
    const el = withAttrs(
      {
        tagName: "BUTTON",
        id: "save-btn",
        className: "SignupCard font-medium",
        textContent: "Save",
      },
      {
        "data-testid": "save-button",
        "aria-label": "Save changes",
      }
    )
    expect(describeElement(el)).toBe('[data-testid="save-button"]')
  })

  it("accepts data-test-id and data-test as fallbacks", () => {
    expect(
      describeElement(
        withAttrs({ tagName: "BUTTON" }, { "data-test-id": "submit" })
      )
    ).toBe('[data-testid="submit"]')
    expect(
      describeElement(withAttrs({ tagName: "BUTTON" }, { "data-test": "x" }))
    ).toBe('[data-testid="x"]')
  })

  it("uses aria-label when no testid is present", () => {
    const el = withAttrs(
      {
        tagName: "BUTTON",
        id: "x",
        className: "font-medium",
        textContent: "Close",
      },
      { "aria-label": "Close dialog" }
    )
    expect(describeElement(el)).toBe('button[aria-label="Close dialog"]')
  })

  it("uses visible text for interactive elements (button, a, summary, label)", () => {
    const btn = makeElement({
      tagName: "BUTTON",
      id: "save-btn",
      textContent: "Sign up",
    })
    expect(describeElement(btn)).toBe('button "Sign up"')

    const link = makeElement({
      tagName: "A",
      className: "font-medium",
      textContent: "  Create\n  account  ",
    })
    expect(describeElement(link)).toBe('a "Create account"')
  })

  it("treats elements with role=button as interactive", () => {
    const el = withAttrs(
      {
        tagName: "DIV",
        className: "font-medium",
        textContent: "Save",
      },
      { role: "button" }
    )
    expect(describeElement(el)).toBe('div "Save"')
  })

  it("treats input[type=submit|button|reset|checkbox|radio] as interactive", () => {
    const submit = withAttrs(
      { tagName: "INPUT", textContent: "" },
      { type: "submit", value: "Go" }
    )
    // input has no textContent; falls through to tag-only fallback.
    expect(describeElement(submit)).toBe("input")

    const checkbox = withAttrs(
      { tagName: "INPUT", id: "tos", textContent: "" },
      { type: "checkbox" }
    )
    // No text → #id fallback.
    expect(describeElement(checkbox)).toBe("#tos")
  })

  it("does NOT use textContent for non-interactive elements", () => {
    const section = makeElement({
      tagName: "SECTION",
      className: "relative",
      textContent: "Lots of page copy here",
    })
    // `relative` is a utility, so tag-only.
    expect(describeElement(section)).toBe("section")
  })

  it("falls back to #id after testid/aria-label/text", () => {
    const el = makeElement({
      tagName: "DIV",
      id: "settings-form",
      className: "flex",
      textContent: "",
    })
    expect(describeElement(el)).toBe("#settings-form")
  })

  it("uses [name=...] on form controls when nothing better is available", () => {
    const input = withAttrs(
      { tagName: "INPUT", className: "w-full border" },
      { name: "email" }
    )
    expect(describeElement(input)).toBe('input[name="email"]')

    // Non-form-control tags with a name attr should not get this treatment —
    // `name` on a <div> is not meaningful.
    const div = withAttrs(
      { tagName: "DIV", className: "relative flex" },
      { name: "whatever" }
    )
    expect(describeElement(div)).toBe("div")
  })
})

describe("describeElement: utility-class filtering", () => {
  it("skips Tailwind utility classes and falls back to tag", () => {
    const el = makeElement({
      tagName: "SECTION",
      className: "relative flex items-center gap-4 px-2",
    })
    expect(describeElement(el)).toBe("section")
  })

  it("skips variant-prefixed utilities (hover:, sm:, etc.)", () => {
    const el = makeElement({
      tagName: "BUTTON",
      className: "hover:bg-red-500 sm:flex focus:outline-none",
    })
    // Interactive but no text → tag-only.
    expect(describeElement(el)).toBe("button")
  })

  it("keeps semantic (component-name) classes", () => {
    const el = makeElement({
      tagName: "DIV",
      className: "flex SignupCard items-center",
    })
    expect(describeElement(el)).toBe("div.SignupCard")
  })

  it("looksLikeUtilityClass recognizes common patterns", () => {
    expect(looksLikeUtilityClass("relative")).toBe(true)
    expect(looksLikeUtilityClass("font-medium")).toBe(true)
    expect(looksLikeUtilityClass("text-xl")).toBe(true)
    expect(looksLikeUtilityClass("hover:bg-red-500")).toBe(true)
    expect(looksLikeUtilityClass("sm:flex")).toBe(true)
    expect(looksLikeUtilityClass("p-4")).toBe(true)
    expect(looksLikeUtilityClass("shadow")).toBe(true)
    expect(looksLikeUtilityClass("rounded-lg")).toBe(true)

    expect(looksLikeUtilityClass("SignupCard")).toBe(false)
    expect(looksLikeUtilityClass("user-menu")).toBe(false)
    expect(looksLikeUtilityClass("nav__item")).toBe(false)
  })
})

describe("describeElement: escaping and truncation", () => {
  it("escapes embedded quotes and backslashes in attribute values", () => {
    const el = withAttrs({ tagName: "BUTTON" }, { "data-testid": 'a"b\\c' })
    expect(describeElement(el)).toBe('[data-testid="a\\"b\\\\c"]')
  })

  it("collapses whitespace and truncates long text", () => {
    const long = "x".repeat(200)
    const el = makeElement({
      tagName: "BUTTON",
      textContent: long,
    })
    const out = describeElement(el)
    expect(out.startsWith('button "')).toBe(true)
    expect(out.endsWith('…"')).toBe(true)
    expect(out.length).toBeLessThan(long.length)
  })
})

describe("getElementTarget: EventTarget guard", () => {
  it("returns undefined for non-Element targets", () => {
    expect(getElementTarget(null)).toBeUndefined()
    // EventTarget that isn't an Element — Bun has no Element global, so
    // passing anything that isn't an instance of Element short-circuits.
    expect(getElementTarget({} as unknown as EventTarget)).toBeUndefined()
  })
})
