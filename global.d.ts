import type * as React from "react";

declare module "ink-text-input" {
  // Minimal fallback types for the ink-text-input component
  const TextInput: any;
  export default TextInput;
}

declare module "aws-amplify/data" {
  // Simplified typings for AWS Amplify Data client used in this project.
  // Extend as needed for stricter type-safety.
  export const events: any;
}

// Node.js built-in module specifiers with "node:" prefix
declare module "node:fs" {
  const fs: any;
  export = fs;
}

declare module "node:fs/promises" {
  const fsp: any;
  export = fsp;
}

declare module "node:path" {
  const path: any;
  export = path;
}

declare module "node:os" {
  const os: any;
  export = os;
}

// Stub for semver when typings are unavailable
declare module "semver" {
  const lt: (...args: any[]) => any;
  const gte: (...args: any[]) => any;
  const compare: (...args: any[]) => any;
  export { lt, gte, compare };
  const _default: any;
  export default _default;
}

// Optional minimal stub for ink if local tooling cannot find its internal typings
declare module "ink" {
  export const render: any;
  export const Box: any;
  export const Text: any;
  export const useInput: any;
  export const useApp: any;
  export const Static: any;
  export const useStdout: any;
  export const measureElement: any;
}