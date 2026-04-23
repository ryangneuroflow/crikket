ALTER TABLE "bug_report_upload_session" ADD COLUMN "parent_issue_ref" text;--> statement-breakpoint
ALTER TABLE "bug_report" ADD COLUMN "github_parent_issue_number" integer;
