CREATE TABLE "agentCommand" (
	"id" text PRIMARY KEY,
	"userId" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"template" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "agentCommand_name_nonempty_check" CHECK (length("name") > 0),
	CONSTRAINT "agentCommand_template_nonempty_check" CHECK (length("template") > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "agentCommand_userId_name_key" ON "agentCommand" ("userId","name");--> statement-breakpoint
CREATE INDEX "agentCommand_userId_enabled_idx" ON "agentCommand" ("userId","enabled");--> statement-breakpoint
ALTER TABLE "agentCommand" ADD CONSTRAINT "agentCommand_userId_user_id_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE;