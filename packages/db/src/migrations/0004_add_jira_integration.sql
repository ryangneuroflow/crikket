CREATE TABLE "organization_jira_integration" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"site_url" text NOT NULL,
	"email" text NOT NULL,
	"project_key" text NOT NULL,
	"issue_type" text DEFAULT 'Bug' NOT NULL,
	"subtask_issue_type" text,
	"api_token_encrypted" text NOT NULL,
	"extra_fields_json" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bug_report" ADD COLUMN "jira_issue_url" text;--> statement-breakpoint
ALTER TABLE "bug_report" ADD COLUMN "jira_issue_key" text;--> statement-breakpoint
ALTER TABLE "bug_report_upload_session" ADD COLUMN "jira_fields" jsonb;--> statement-breakpoint
ALTER TABLE "bug_report_upload_session" ADD COLUMN "forward_target" text;--> statement-breakpoint
ALTER TABLE "organization_jira_integration" ADD CONSTRAINT "organization_jira_integration_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "org_jira_integration_organizationId_idx" ON "organization_jira_integration" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "org_jira_integration_organizationId_unique" ON "organization_jira_integration" USING btree ("organization_id");