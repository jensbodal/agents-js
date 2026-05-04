// -- Types --------------------------------------------------------------------

// -- Strict conformance -------------------------------------------------------
export {
  createStrictValidator,
  createStrictValidatorWith,
  type StrictOptions,
} from "./conformance/strict.ts";
// -- Constants ----------------------------------------------------------------
export { SKILL_FILENAME } from "./constants.ts";
export { normalizeFrontmatter } from "./core/normalize.ts";

// -- Parse + normalize --------------------------------------------------------
export {
  type ParseFrontmatterResult,
  parseSkillDocument,
  type SplitResult,
  splitSkillDocument,
} from "./core/parse.ts";
// -- Validation (tolerant) ----------------------------------------------------
export {
  DESCRIPTION_MAX_LENGTH,
  NAME_MAX_LENGTH,
  SKILL_KNOWN_KEYS,
  validateSkill,
} from "./core/validate.ts";
export { parseSkillYaml, YamlParseError } from "./core/yaml.ts";
// -- Registry -----------------------------------------------------------------
export { InMemoryRegistry } from "./registry/in-memory.ts";
// -- Runtime ------------------------------------------------------------------
export { listSkills, loadSkill, SkillLoadError } from "./runtime/load.ts";
export { discoverSkillDirs, resolveSkillDir } from "./runtime/resolve.ts";
export type {
  LoadOptions,
  Skill,
  SkillFrontmatter,
  SkillMeta,
  ValidationResult,
} from "./types.ts";
