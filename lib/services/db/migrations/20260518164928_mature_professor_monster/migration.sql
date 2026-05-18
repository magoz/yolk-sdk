CREATE TYPE "KnowledgeArtifactKind" AS ENUM('original', 'extracted_text', 'thumbnail', 'transcript', 'caption', 'structured');--> statement-breakpoint
CREATE TYPE "KnowledgeContextPolicy" AS ENUM('pinned', 'routable', 'searchable', 'archival');--> statement-breakpoint
CREATE TYPE "KnowledgeLifecycleStatus" AS ENUM('draft', 'processing', 'ready', 'error', 'archived', 'deleted');--> statement-breakpoint
CREATE TYPE "KnowledgeLinkType" AS ENUM('cites', 'supports', 'contradicts', 'supersedes', 'mentions', 'derived_from', 'related_to');--> statement-breakpoint
CREATE TYPE "KnowledgeObjectRole" AS ENUM('source', 'note', 'operating_protocol', 'knowledge_map', 'compiled_truth', 'decision');--> statement-breakpoint
CREATE TYPE "KnowledgeProvenanceSourceKind" AS ENUM('upload', 'user_statement', 'url', 'generated', 'imported', 'external_api');--> statement-breakpoint
CREATE TYPE "KnowledgeRepresentationModality" AS ENUM('text', 'image', 'audio', 'video', 'table');--> statement-breakpoint
CREATE TYPE "KnowledgeRepresentationStatus" AS ENUM('pending', 'processing', 'ready', 'error');--> statement-breakpoint
CREATE TABLE "knowledgeArtifact" (
	"id" text PRIMARY KEY,
	"objectId" text NOT NULL,
	"kind" "KnowledgeArtifactKind" NOT NULL,
	"storageKey" text NOT NULL,
	"mediaType" text,
	"byteSize" integer,
	"checksum" text,
	"metadata" jsonb DEFAULT '{}' NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "knowledgeArtifact_storageKey_nonempty_check" CHECK (length("storageKey") > 0),
	CONSTRAINT "knowledgeArtifact_byteSize_check" CHECK ("byteSize" IS NULL OR "byteSize" >= 0)
);
--> statement-breakpoint
CREATE TABLE "knowledgeChunk" (
	"id" text PRIMARY KEY,
	"objectId" text NOT NULL,
	"representationId" text NOT NULL,
	"content" text NOT NULL,
	"embedding" vector(1536) NOT NULL,
	"position" integer NOT NULL,
	"tokenCount" integer DEFAULT 0 NOT NULL,
	"metadata" jsonb DEFAULT '{}' NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "knowledgeChunk_representationId_position_key" UNIQUE("representationId","position"),
	CONSTRAINT "knowledgeChunk_content_nonempty_check" CHECK (length("content") > 0),
	CONSTRAINT "knowledgeChunk_position_check" CHECK ("position" >= 0),
	CONSTRAINT "knowledgeChunk_tokenCount_check" CHECK ("tokenCount" >= 0)
);
--> statement-breakpoint
CREATE TABLE "knowledgeLink" (
	"id" text PRIMARY KEY,
	"fromObjectId" text NOT NULL,
	"toObjectId" text NOT NULL,
	"type" "KnowledgeLinkType" NOT NULL,
	"metadata" jsonb DEFAULT '{}' NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "knowledgeLink_edge_key" UNIQUE("fromObjectId","toObjectId","type"),
	CONSTRAINT "knowledgeLink_no_self_link_check" CHECK ("fromObjectId" <> "toObjectId")
);
--> statement-breakpoint
CREATE TABLE "knowledgeObject" (
	"id" text PRIMARY KEY,
	"userId" text NOT NULL,
	"role" "KnowledgeObjectRole" NOT NULL,
	"title" text NOT NULL,
	"status" "KnowledgeLifecycleStatus" DEFAULT 'draft'::"KnowledgeLifecycleStatus" NOT NULL,
	"contextPolicy" "KnowledgeContextPolicy" DEFAULT 'searchable'::"KnowledgeContextPolicy" NOT NULL,
	"summary" text,
	"metadata" jsonb DEFAULT '{}' NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "knowledgeObject_title_nonempty_check" CHECK (length("title") > 0)
);
--> statement-breakpoint
CREATE TABLE "knowledgeProvenance" (
	"id" text PRIMARY KEY,
	"objectId" text NOT NULL,
	"artifactId" text,
	"sourceKind" "KnowledgeProvenanceSourceKind" NOT NULL,
	"sourceLabel" text NOT NULL,
	"sourceUrl" text,
	"observedAt" timestamp,
	"metadata" jsonb DEFAULT '{}' NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "knowledgeProvenance_sourceLabel_nonempty_check" CHECK (length("sourceLabel") > 0)
);
--> statement-breakpoint
CREATE TABLE "knowledgeRepresentation" (
	"id" text PRIMARY KEY,
	"objectId" text NOT NULL,
	"artifactId" text,
	"modality" "KnowledgeRepresentationModality" NOT NULL,
	"status" "KnowledgeRepresentationStatus" DEFAULT 'pending'::"KnowledgeRepresentationStatus" NOT NULL,
	"contentText" text,
	"summary" text,
	"model" text,
	"errorMessage" text,
	"metadata" jsonb DEFAULT '{}' NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "knowledgeArtifact_objectId_idx" ON "knowledgeArtifact" ("objectId");--> statement-breakpoint
CREATE UNIQUE INDEX "knowledgeArtifact_storageKey_key" ON "knowledgeArtifact" ("storageKey");--> statement-breakpoint
CREATE INDEX "knowledgeChunk_embedding_idx" ON "knowledgeChunk" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "knowledgeChunk_content_fts_idx" ON "knowledgeChunk" USING gin (to_tsvector('english', "content"));--> statement-breakpoint
CREATE INDEX "knowledgeChunk_objectId_idx" ON "knowledgeChunk" ("objectId");--> statement-breakpoint
CREATE INDEX "knowledgeLink_fromObjectId_idx" ON "knowledgeLink" ("fromObjectId");--> statement-breakpoint
CREATE INDEX "knowledgeLink_toObjectId_idx" ON "knowledgeLink" ("toObjectId");--> statement-breakpoint
CREATE INDEX "knowledgeObject_userId_createdAt_idx" ON "knowledgeObject" ("userId","createdAt");--> statement-breakpoint
CREATE INDEX "knowledgeObject_userId_contextPolicy_idx" ON "knowledgeObject" ("userId","contextPolicy");--> statement-breakpoint
CREATE INDEX "knowledgeProvenance_objectId_idx" ON "knowledgeProvenance" ("objectId");--> statement-breakpoint
CREATE INDEX "knowledgeRepresentation_objectId_status_idx" ON "knowledgeRepresentation" ("objectId","status");--> statement-breakpoint
CREATE INDEX "knowledgeRepresentation_artifactId_idx" ON "knowledgeRepresentation" ("artifactId");--> statement-breakpoint
CREATE INDEX "ragChunk_content_fts_idx" ON "ragChunk" USING gin (to_tsvector('english', "content"));--> statement-breakpoint
ALTER TABLE "knowledgeArtifact" ADD CONSTRAINT "knowledgeArtifact_objectId_knowledgeObject_id_fkey" FOREIGN KEY ("objectId") REFERENCES "knowledgeObject"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "knowledgeChunk" ADD CONSTRAINT "knowledgeChunk_objectId_knowledgeObject_id_fkey" FOREIGN KEY ("objectId") REFERENCES "knowledgeObject"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "knowledgeChunk" ADD CONSTRAINT "knowledgeChunk_representationId_knowledgeRepresentation_id_fkey" FOREIGN KEY ("representationId") REFERENCES "knowledgeRepresentation"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "knowledgeLink" ADD CONSTRAINT "knowledgeLink_fromObjectId_knowledgeObject_id_fkey" FOREIGN KEY ("fromObjectId") REFERENCES "knowledgeObject"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "knowledgeLink" ADD CONSTRAINT "knowledgeLink_toObjectId_knowledgeObject_id_fkey" FOREIGN KEY ("toObjectId") REFERENCES "knowledgeObject"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "knowledgeObject" ADD CONSTRAINT "knowledgeObject_userId_user_id_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "knowledgeProvenance" ADD CONSTRAINT "knowledgeProvenance_objectId_knowledgeObject_id_fkey" FOREIGN KEY ("objectId") REFERENCES "knowledgeObject"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "knowledgeProvenance" ADD CONSTRAINT "knowledgeProvenance_artifactId_knowledgeArtifact_id_fkey" FOREIGN KEY ("artifactId") REFERENCES "knowledgeArtifact"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "knowledgeRepresentation" ADD CONSTRAINT "knowledgeRepresentation_objectId_knowledgeObject_id_fkey" FOREIGN KEY ("objectId") REFERENCES "knowledgeObject"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "knowledgeRepresentation" ADD CONSTRAINT "knowledgeRepresentation_artifactId_knowledgeArtifact_id_fkey" FOREIGN KEY ("artifactId") REFERENCES "knowledgeArtifact"("id") ON DELETE SET NULL;