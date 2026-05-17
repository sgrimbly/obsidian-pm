import type { Task, GanttGranularity } from '../../types'
import { flattenTasks } from '../../store/TaskTreeOps'
import { Temporal, today, parsePlainDate } from '../../dates'

export const ROW_HEIGHT = 44
export const HEADER_HEIGHT = 56
export const LABEL_WIDTH = 280
export const BAR_PADDING = 8
export const BAR_BORDER_RADIUS = 7

// Notion-style: granularity = "what fits a typical screen-width" (~1500px).
// day:    ~25 days visible        (60 * 25 = 1500)
// week:   ~7 days visible         (215 * 7 = 1505)
// month:  ~30 days visible        (50 * 30 = 1500)
// quarter:~180 days visible       (8 * 180 = 1440 → ~6 months)
// year:   ~365 days visible       (4 * 365 = 1460 → 1 year)
export const DAY_WIDTH: Record<GanttGranularity, number> = {
  day: 60,
  week: 215,
  month: 50,
  quarter: 9,
  year: 4
}

export interface TimelineCfg {
  startDate: Temporal.PlainDate
  endDate: Temporal.PlainDate
  dayWidth: number
  granularity: GanttGranularity
  totalDays: number
  totalWidth: number
}

// Minimum visible range — enforces a sensible "fit" for the granularity.
const MIN_DAYS: Record<GanttGranularity, number> = {
  day: 21,
  week: 14,
  month: 30,
  quarter: 180,
  year: 365
}

export function buildTimelineConfig(tasks: Task[], granularity: GanttGranularity): TimelineCfg {
  const allTasks = flattenTasks(tasks).map((f) => f.task)
  const dates: Temporal.PlainDate[] = []

  for (const t of allTasks) {
    const start = parsePlainDate(t.start)
    const due = parsePlainDate(t.due)
    if (start) dates.push(start)
    if (due) dates.push(due)
  }

  const now = today()
  dates.push(now)

  let startDate = dates.reduce((min, d) => (Temporal.PlainDate.compare(d, min) < 0 ? d : min), dates[0])
  let endDate = dates.reduce((max, d) => (Temporal.PlainDate.compare(d, max) > 0 ? d : max), dates[0])

  // Granularity-aware padding past the data range. This makes the timeline
  // feel continuous (Notion-style): you can scroll forward/backward into
  // empty space — "year" granularity defaults to showing 1 year visible
  // but you can scroll further past where data exists.
  const PADDING_DAYS: Record<GanttGranularity, number> = {
    day: 7,
    week: 14,
    month: 60,
    quarter: 180,
    year: 365
  }
  const pad = PADDING_DAYS[granularity]
  startDate = startDate.subtract({ days: pad })
  endDate = endDate.add({ days: pad })

  // Enforce minimum visible range based on granularity (already handled by
  // padding above for sparse data, but kept for safety with tiny ranges).
  const currentSpan = endDate.since(startDate, { largestUnit: 'days' }).days
  if (currentSpan < MIN_DAYS[granularity]) {
    const extra = Math.ceil((MIN_DAYS[granularity] - currentSpan) / 2)
    startDate = startDate.subtract({ days: extra })
    endDate = endDate.add({ days: extra })
  }

  // Snap to month start for cleaner headers
  if (granularity === 'week' || granularity === 'month' || granularity === 'quarter') {
    startDate = startDate.with({ day: 1 })
  } else if (granularity === 'year') {
    startDate = startDate.with({ month: 1, day: 1 })
  }

  const dayWidth = DAY_WIDTH[granularity]
  const totalDays = endDate.since(startDate, { largestUnit: 'days' }).days
  return {
    startDate,
    endDate,
    dayWidth,
    granularity,
    totalDays,
    totalWidth: totalDays * dayWidth
  }
}

export function dateToX(cfg: TimelineCfg, date: Temporal.PlainDate): number {
  return date.since(cfg.startDate, { largestUnit: 'days' }).days * cfg.dayWidth
}

export function xToDate(cfg: TimelineCfg, x: number): Temporal.PlainDate {
  return cfg.startDate.add({ days: Math.round(x / cfg.dayWidth) })
}

/**
 * Returns snap-point X positions for the given granularity.
 * - day: every day border
 * - week: every Monday + mid-week (Thursday)
 * - month: 1st, ~8th, ~15th, ~22nd of each month
 * - quarter: 1st of each month
 */
export function getSnapPoints(cfg: TimelineCfg): number[] {
  const points: number[] = []
  const { startDate, totalDays, dayWidth, granularity } = cfg

  for (let i = 0; i <= totalDays; i++) {
    const d = startDate.add({ days: i })
    const x = i * dayWidth

    if (granularity === 'day' || granularity === 'week') {
      points.push(x)
    } else if (granularity === 'month') {
      // Snap to every Monday (week boundary) for finer control at month zoom.
      if (d.day === 1 || d.dayOfWeek === 1) points.push(x)
    } else if (granularity === 'quarter' || granularity === 'year') {
      // Snap to 1st of each month.
      if (d.day === 1) points.push(x)
    }
  }
  return points
}

/** Snap an x position to the nearest snap point within a threshold. */
export function snapX(x: number, snapPoints: number[], threshold: number): number {
  let closest = x
  let minDist = Infinity
  for (const sp of snapPoints) {
    const dist = Math.abs(x - sp)
    if (dist < minDist) {
      minDist = dist
      closest = sp
    }
    if (sp > x + threshold) break // snap points are sorted, no need to continue
  }
  return minDist <= threshold ? closest : x
}

export function getWeekNumber(d: Temporal.PlainDate): number {
  return d.weekOfYear ?? 0
}
