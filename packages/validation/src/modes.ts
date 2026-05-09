export const VALIDATION_MODES = ["strict", "loose", "filter"] as const;

export type ValidationMode = (typeof VALIDATION_MODES)[number];

export interface ValidationOptions {
  mode?: ValidationMode;
}

export function isValidationMode(value: string): value is ValidationMode {
  return VALIDATION_MODES.includes(value as ValidationMode);
}

export function resolveValidationMode(options: ValidationOptions = {}): ValidationMode {
  return options.mode ?? "strict";
}
