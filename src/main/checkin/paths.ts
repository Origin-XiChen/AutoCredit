import { readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 展开 %VAR%、~ 以及资源管理器复制路径时带上的引号。 */
export function expandUserPath(input: string): string {
  let value = input.trim()
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1).trim()
  }
  value = value.replace(/%([^%]+)%/g, (match, name: string) => process.env[name] ?? match)
  if (value === '~') return homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) return join(homedir(), value.slice(2))
  return value
}

/** 列出目录下名称匹配的下一级文件夹，读取失败时返回空数组。 */
export function matchingDirectories(root: string, pattern: RegExp): string[] {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && pattern.test(entry.name))
      .map((entry) => join(root, entry.name))
  } catch {
    return []
  }
}

/** 去重并保留顺序。 */
export function uniquePaths(paths: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const path of paths) {
    const key = path.toLowerCase()
    if (!path || seen.has(key)) continue
    seen.add(key)
    result.push(path)
  }
  return result
}
