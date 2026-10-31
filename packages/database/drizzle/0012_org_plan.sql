CREATE TYPE "public"."plan" AS ENUM('FREE', 'PRO', 'TEAM', 'BUSINESS', 'ENTERPRISE');--> statement-breakpoint
ALTER TABLE "organisations" ADD COLUMN "plan" "plan" DEFAULT 'FREE' NOT NULL;