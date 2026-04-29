-- Drop agents.run_on. Local-subprocess execution was removed; every
-- agent must now route to a remote opencara CLI host (pin via host_id
-- or pick any idle device when host_id is null). Existing rows whose
-- run_on was 'local' will fall back to the "any device" path; if no
-- devices are paired the dispatcher errors with a clear message.

ALTER TABLE "agents" DROP COLUMN IF EXISTS "run_on";
