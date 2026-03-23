-- Deploy AFTER the code changes removing lock usage are live.
-- Summary coordination now uses atomic CAS on the tasks table (queue column).
DROP TABLE IF EXISTS locks;
