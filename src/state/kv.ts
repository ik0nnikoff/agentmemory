import type { ISdk } from 'iii-sdk'

export class StateKV {
  constructor(private sdk: ISdk) {}

  async get<T = unknown>(scope: string, key: string): Promise<T | null> {
    return this.sdk.trigger<{ scope: string; key: string }, T | null>({
      function_id: 'state::get',
      payload: { scope, key },
    })
  }

  async set<T = unknown>(scope: string, key: string, value: T): Promise<T> {
    return this.sdk.trigger<{ scope: string; key: string; value: T }, T>({
      function_id: 'state::set',
      payload: { scope, key, value },
    })
  }

  async update<T = unknown>(
    scope: string,
    key: string,
    ops: Array<{ type: string; path: string; value?: unknown }>,
  ): Promise<T> {
    return this.sdk.trigger<
      { scope: string; key: string; ops: Array<{ type: string; path: string; value?: unknown }> },
      T
    >({
      function_id: 'state::update',
      payload: { scope, key, ops },
    })
  }

  async delete(scope: string, key: string): Promise<void> {
    return this.sdk.trigger<{ scope: string; key: string }, void>({
      function_id: 'state::delete',
      payload: { scope, key },
    })
  }

  async list<T = unknown>(scope: string): Promise<T[]> {
    return this.sdk.trigger<{ scope: string }, T[]>({
      function_id: 'state::list',
      payload: { scope },
    })
  }

  /**
   * Every scope (group) that currently holds at least one key.
   *
   * Contract established against iii-engine 0.11.2 on an isolated Docker
   * stand (wave 7, phase 5 spike):
   *   - input is `StateListGroupsInput`; an object is required (`null` and
   *     a bare string are rejected with "invalid type ... expected struct
   *     StateListGroupsInput"). Unknown fields are IGNORED: `{}`,
   *     `{prefix}`, `{scope}`, `{pattern}` all return the identical list,
   *     so the engine offers NO server-side filtering — callers filter.
   *   - output is `{ groups: string[] }` — every scope in the store, not
   *     just index ones. 3008 groups answered in 3-18 ms / 72 KB.
   *   - a scope stays in the list after its last key is deleted, and
   *     disappears only after an engine restart.
   *
   * Throws when the response has no `groups` array: callers that delete
   * by this list must fail closed rather than act on a partial picture.
   */
  async listGroups(): Promise<string[]> {
    const response = await this.sdk.trigger<
      Record<string, never>,
      { groups?: unknown } | null
    >({
      function_id: 'state::list_groups',
      payload: {},
    })
    const groups = response?.groups
    if (!Array.isArray(groups)) {
      throw new Error("state::list_groups response: missing 'groups' array")
    }
    for (const group of groups) {
      if (typeof group !== 'string') {
        throw new Error("state::list_groups response: non-string group entry")
      }
    }
    return groups as string[]
  }
}
