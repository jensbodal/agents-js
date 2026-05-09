import type { Skill } from "../types.ts";

/**
 * Session-scoped in-memory skill registry. No persistence, no
 * networking — callers hydrate at startup and discard on shutdown.
 *
 * The registry keys skills by `skill.name`. Re-adding a skill with
 * the same name replaces the previous entry; callers that want
 * insert-only semantics should use {@link InMemoryRegistry.has} to
 * check first.
 */
export class InMemoryRegistry {
  private readonly skills = new Map<string, Skill>();

  /** Add (or replace) a skill. Returns the skill for call-chaining. */
  add(skill: Skill): Skill {
    this.skills.set(skill.name, skill);
    return skill;
  }

  /** Retrieve a skill by name. */
  get(name: string): Skill | undefined {
    return this.skills.get(name);
  }

  /** Check membership without triggering a lookup. */
  has(name: string): boolean {
    return this.skills.has(name);
  }

  /** Remove a skill by name. Returns whether anything was removed. */
  remove(name: string): boolean {
    return this.skills.delete(name);
  }

  /** Number of skills currently registered. */
  get size(): number {
    return this.skills.size;
  }

  /** Enumerate all registered skills, sorted by name. */
  list(): Skill[] {
    return [...this.skills.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Drop all entries. */
  clear(): void {
    this.skills.clear();
  }
}
