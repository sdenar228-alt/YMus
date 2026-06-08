/** @type {import('jest').Config} */
module.exports = {
  preset: "ts-jest",
  // Default environment is "node" (used by tests/manifest.test.ts and
  // background-only tests). Files in tests/content/** that need a DOM
  // can opt-in per-file via the docblock pragma:
  //   /**
  //    * @jest-environment jsdom
  //    */
  // The "jest-environment-jsdom" package must be installed (devDependencies).
  testEnvironment: "node",
  // setupFiles run in every test environment (node and jsdom) so that
  // chrome.* APIs are mocked uniformly across all test files.
  setupFiles: ["jest-webextension-mock", "<rootDir>/tests/setup/chrome-storage-fix.js"],
  testMatch: ["**/tests/**/*.test.ts", "**/src/**/__tests__/**/*.test.ts"],
  moduleFileExtensions: ["ts", "tsx", "js", "jsx", "json"],
  transform: {
    "^.+\\.tsx?$": [
      "ts-jest",
      {
        tsconfig: {
          module: "CommonJS",
          moduleResolution: "node",
          esModuleInterop: true,
          target: "ES2020",
          lib: ["ES2020", "DOM", "DOM.Iterable"],
          strict: true,
          skipLibCheck: true,
          resolveJsonModule: true,
          allowJs: true,
          types: ["jest", "chrome", "node"]
        }
      }
    ]
  }
};
