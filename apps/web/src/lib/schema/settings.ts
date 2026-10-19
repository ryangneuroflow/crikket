import * as z from "zod"

import { organizationFormSchema } from "@/lib/schema/organization"

const CAPTURE_ORIGIN_SPLIT_PATTERN = /\r?\n|,/

function hasOnlyValidCaptureOrigins(value: string): boolean {
  const entries = value
    .split(CAPTURE_ORIGIN_SPLIT_PATTERN)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)

  if (entries.length === 0) {
    return false
  }

  return entries.every((entry) => {
    try {
      const parsedOrigin = new URL(entry)
      return (
        parsedOrigin.protocol === "http:" || parsedOrigin.protocol === "https:"
      )
    } catch {
      return false
    }
  })
}

function isBlankOrJsonObject(value: string): boolean {
  if (value === "") return true
  try {
    const parsed: unknown = JSON.parse(value)
    return (
      typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    )
  } catch {
    return false
  }
}

export const userNameFormSchema = z.object({
  name: z.string().min(1, "Name is required"),
})

export const userPasswordFormSchema = z
  .object({
    currentPassword: z.string().min(1, "Current password is required"),
    newPassword: z.string().min(8, "Password must be at least 8 characters"),
    confirmPassword: z.string().min(1, "Confirm password is required"),
  })
  .refine((value) => value.newPassword === value.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  })

export const organizationSettingsFormSchema = organizationFormSchema

export const captureKeyCreateFormSchema = z.object({
  label: z.string().trim().min(1, "Label is required").max(80),
  allowedOrigins: z
    .string()
    .trim()
    .min(1, "At least one origin is required")
    .refine(hasOnlyValidCaptureOrigins, {
      message: "Use one valid HTTP(S) origin per line.",
    }),
})

export const captureKeyOriginsFormSchema = z.object({
  allowedOrigins: z
    .string()
    .trim()
    .min(1, "At least one origin is required")
    .refine(hasOnlyValidCaptureOrigins, {
      message: "Use one valid HTTP(S) origin per line.",
    }),
})

export const inviteMemberFormSchema = z.object({
  email: z.email("Enter a valid email address"),
  role: z.enum(["admin", "member"]),
})

export const githubIntegrationFormSchema = z.object({
  repo: z
    .string()
    .trim()
    .regex(/^[^/\s]+\/[^/\s]+$/, {
      message: "Use the format owner/repo",
    }),
  // Token is only required the first time; on updates an empty string means "keep existing".
  token: z.string(),
})

export const jiraIntegrationFormSchema = z.object({
  siteUrl: z.url({ message: "Enter the Jira site URL (https://...)" }),
  email: z.email("Enter a valid email address"),
  projectKey: z
    .string()
    .trim()
    .regex(/^[A-Za-z][A-Za-z0-9_]*$/, {
      message: "Use the project key, e.g. ABC",
    }),
  issueType: z.string().trim().max(80),
  subtaskIssueType: z.string().trim().max(80),
  // Token is only required the first time; on updates an empty string means "keep existing".
  apiToken: z.string(),
  extraFieldsJson: z
    .string()
    .trim()
    .max(8000, "Additional fields JSON is too long")
    .refine(isBlankOrJsonObject, {
      message:
        'Must be a JSON object, e.g. {"customfield_10001": {"id": "123"}}',
    }),
})
