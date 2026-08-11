-- Service hook subscription ids for an Azure DevOps project.
--
-- Unlike a GitHub App (one installation delivers every subscribed event), Azure
-- DevOps needs one subscription per (project, event type), each with its own id.
-- Removing a project has to delete them individually, so the ids are recorded
-- here at creation. Storing them beats re-querying by URL at teardown: the query
-- would have to match on consumer inputs and cannot distinguish two repos in the
-- same team project pointing at the same endpoint.
--
-- Also records the Azure DevOps team project GUID, which is required by the work
-- item and service hook APIs and is not derivable from the repository id.
ALTER TABLE "projects" ADD COLUMN "azdo_subscription_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "azdo_project_id" text;
