/**
 * Deterministic IDs used by both global-setup (seeding) and test specs (navigation/assertions).
 * Avoids env var propagation issues between globalSetup and test workers.
 */

// Shared test user — used by most specs via authedContext fixture
export const TEST_USER_ID = 'e2e-test-user-main'
