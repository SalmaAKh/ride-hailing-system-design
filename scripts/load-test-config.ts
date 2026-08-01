// Shared between seed-load-test.ts and load-test.ts. Deliberately its own
// file with no other code - importing a script that has a top-level
// main().catch(...) call would re-run that entire script as a side effect
// of the import, which is exactly the bug this file avoids.
export const LOAD_TEST_PASSWORD = 'load-test-password-123';
