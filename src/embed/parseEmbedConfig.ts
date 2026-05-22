import { parseYaml } from 'obsidian'
import type { GanttGranularity, ViewMode } from '../types'

/**
 * Configuration accepted in a `pm-gantt` / `pm-table` / `pm-kanban` /
 * `pm-calendar` code block body. The body is parsed as YAML.
 *
 * Required:
 *   - `file`: vault-relative path to a `pm-project: true` markdown file.
 *
 * Optional:
 *   - `height`: pixel height of the embed viewport (default 480).
 *   - `granularity`: gantt-specific zoom (day/week/month/quarter/year).
 *   - `view`: override the view kind (gantt/table/kanban/calendar). Normally
 *     determined by the code-block language, but a `pm-project` block can
 *     accept any view here.
 */
export interface EmbedConfig {
  file: string
  height: number
  granularity: GanttGranularity | null
  view: ViewMode | null
}

export interface EmbedParseResult {
  config: EmbedConfig | null
  error: string | null
}

const DEFAULT_HEIGHT = 480
const VALID_VIEWS: ReadonlySet<ViewMode> = new Set(['gantt', 'table', 'kanban', 'calendar'])
const VALID_GRANULARITY: ReadonlySet<GanttGranularity> = new Set(['day', 'week', 'month', 'quarter', 'year'])

export function parseEmbedConfig(source: string): EmbedParseResult {
  let raw: unknown
  try {
    raw = parseYaml(source) ?? {}
  } catch (e) {
    return { config: null, error: `Invalid YAML: ${(e as Error).message}` }
  }

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { config: null, error: 'Embed body must be a YAML mapping (key: value pairs).' }
  }

  const obj = raw as Record<string, unknown>

  const file = typeof obj['file'] === 'string' ? (obj['file'] as string).trim() : ''
  if (!file) {
    return { config: null, error: 'Missing required `file:` — vault-relative path to a project file.' }
  }

  let height = DEFAULT_HEIGHT
  if (obj['height'] !== undefined) {
    const h = Number(obj['height'])
    if (!Number.isFinite(h) || h < 100) {
      return { config: null, error: '`height:` must be a number ≥ 100.' }
    }
    height = Math.floor(h)
  }

  let granularity: GanttGranularity | null = null
  if (obj['granularity'] !== undefined) {
    const g = String(obj['granularity'])
    if (!VALID_GRANULARITY.has(g as GanttGranularity)) {
      return { config: null, error: `Invalid \`granularity:\` "${g}" — one of: day, week, month, quarter, year.` }
    }
    granularity = g as GanttGranularity
  }

  let view: ViewMode | null = null
  if (obj['view'] !== undefined) {
    const v = String(obj['view'])
    if (!VALID_VIEWS.has(v as ViewMode)) {
      return { config: null, error: `Invalid \`view:\` "${v}" — one of: gantt, table, kanban, calendar.` }
    }
    view = v as ViewMode
  }

  return { config: { file, height, granularity, view }, error: null }
}
