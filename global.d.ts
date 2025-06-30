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