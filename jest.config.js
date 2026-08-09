/** @type {import('jest').Config} */
module.exports = {
	preset: "ts-jest",
	testEnvironment: "node",
	// Suites share the one test database and truncate between cases; parallel
	// workers race on it.
	maxWorkers: 1,
};
