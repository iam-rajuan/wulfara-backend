module.exports = {
  testEnvironment: 'node',
  setupFiles: ['<rootDir>/tests/env.setup.js'],
  setupFilesAfterEnv: ['<rootDir>/tests/setup.js'],
  testMatch: ['<rootDir>/tests/**/*.test.js'],
  testTimeout: 30000,
};
