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

function isViewMode(value: string): value is ViewMode {
  return VALID_VIEWS.has(value as ViewMode)
}

function isGanttGranularity(value: string): value is GanttGranularity {
  return VALID_GRANULARITY.has(value as GanttGranularity)
}

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

  const fileValue = obj['file']
  const file = typeof fileValue === 'string' ? fileValue.trim() : ''
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
    if (typeof obj['granularity'] !== 'string') {
      return { config: null, error: '`granularity:` must be a string — one of: day, week, month, quarter, year.' }
    }
    const g = obj['granularity']
    if (!isGanttGranularity(g)) {
      return { config: null, error: `Invalid \`granularity:\` "${g}" — one of: day, week, month, quarter, year.` }
    }
    granularity = g
  }

  let view: ViewMode | null = null
  if (obj['view'] !== undefined) {
    if (typeof obj['view'] !== 'string') {
      return { config: null, error: '`view:` must be a string — one of: gantt, table, kanban, calendar.' }
    }
    const v = obj['view']
    if (!isViewMode(v)) {
      return { config: null, error: `Invalid \`view:\` "${v}" — one of: gantt, table, kanban, calendar.` }
    }
    view = v
  }

  return { config: { file, height, granularity, view }, error: null }
}
