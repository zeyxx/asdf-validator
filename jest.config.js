/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],
  collectCoverageFrom: [
    'index.ts',
    'daemon.ts',
    'cli.ts',
    '!**/node_modules/**',
  ],
  coverageThreshold: {
    global: {
      branches: 30,
      functions: 45,
      lines: 45,
      statements: 45,
    },
  },
  coverageReporters: ['text', 'text-summary', 'html'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  verbose: true,
};
