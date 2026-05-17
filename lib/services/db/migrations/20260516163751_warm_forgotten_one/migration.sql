CREATE TABLE IF NOT EXISTS "agentSkill" (
	"id" text PRIMARY KEY,
	"userId" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"content" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "agentSkill_name_nonempty_check" CHECK (length("name") > 0),
	CONSTRAINT "agentSkill_description_nonempty_check" CHECK (length("description") > 0),
	CONSTRAINT "agentSkill_content_nonempty_check" CHECK (length("content") > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agentSkill_userId_name_key" ON "agentSkill" ("userId","name");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agentSkill_userId_enabled_idx" ON "agentSkill" ("userId","enabled");
