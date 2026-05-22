import { ButtonComponent } from 'obsidian'
import type PMPlugin from '../../main'
import type { Project, Task, FilterState } from '../../types'
import type { SubView } from '../SubView'
import { applyTaskFilterPromote } from '../../store/TaskFilter'
import { flattenTasks, findTask } from '../../store/TaskTreeOps'
import { getStatusConfig, safeAsync } from '../../utils'
import { COLOR_ACCENT } from '../../constants'
import { Temporal, today, parsePlainDate } from '../../dates'
import { openTaskModal } from '../../ui/ModalFactory'

/**
 * Calendar (month-grid) view.
 *
 * - 6-row × 7-column grid of dates (always shows the full month plus the
 *   surrounding-week padding).
 * - Each task whose [start, due] range covers part of a week renders as a
 *   single **continuous bar** spanning those columns. Multi-week tasks
 *   produce one bar segment per week, with continuation arrows on the
 *   wrapping edges. Within a week, segments are lane-packed so they don't
 *   visually overlap.
 * - Dragging a bar to a different cell shifts the task's start/due by the
 *   offset between the task's anchor (`start` if set, else `due`) and the
 *   drop cell, preserving duration.
 */
export class CalendarView implements SubView {
  private currentMonth: { year: number; month: number }
  private cleanupFns: (() => void)[] = []

  constructor(
    private container: HTMLElement,
    private project: Project,
    private plugin: PMPlugin,
    private onRefresh: () => Promise<void>,
    private filter: FilterState
  ) {
    const t = today()
    this.currentMonth = { year: t.year, month: t.month }
  }

  destroy(): void {
    for (const fn of this.cleanupFns) fn()
    this.cleanupFns = []
  }

  render(): void {
    this.destroy()
    this.container.empty()
    this.container.addClass('pm-calendar-view')
    this.renderToolbar()
    this.renderGrid()
  }

  // ─── Toolbar ────────────────────────────────────────────────────────────
  private renderToolbar(): void {
    const bar = this.container.createDiv('pm-calendar-toolbar')
    new ButtonComponent(bar).setButtonText('◀').onClick(() => this.shiftMonth(-1))
    new ButtonComponent(bar).setButtonText('Today').onClick(() => {
      const t = today()
      this.currentMonth = { year: t.year, month: t.month }
      this.render()
    })
    new ButtonComponent(bar).setButtonText('▶').onClick(() => this.shiftMonth(1))
    const label = bar.createEl('span', { cls: 'pm-calendar-month-label' })
    const monthName = Temporal.PlainDate.from({
      year: this.currentMonth.year,
      month: this.currentMonth.month,
      day: 1
    }).toLocaleString(undefined, { month: 'long', year: 'numeric' })
    label.textContent = monthName
  }

  private shiftMonth(delta: number): void {
    let { year, month } = this.currentMonth
    month += delta
    while (month < 1) {
      month += 12
      year -= 1
    }
    while (month > 12) {
      month -= 12
      year += 1
    }
    this.currentMonth = { year, month }
    this.render()
  }

  // ─── Grid ──────────────────────────────────────────────────────────────
  private renderGrid(): void {
    const grid = this.container.createDiv('pm-calendar-grid')

    // Day-of-week header row.
    const dowRow = grid.createDiv('pm-calendar-dow-row')
    for (const dow of ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']) {
      dowRow.createDiv('pm-calendar-dow').setText(dow)
    }

    // Compute first day of grid: the Monday of the week containing the 1st.
    const firstOfMonth = Temporal.PlainDate.from({
      year: this.currentMonth.year,
      month: this.currentMonth.month,
      day: 1
    })
    const offset = firstOfMonth.dayOfWeek - 1 // 0..6
    const gridStart = firstOfMonth.subtract({ days: offset })

    const activeTasks = applyTaskFilterPromote(this.project.tasks, this.filter, this.plugin.settings.statuses)
    const flatTasks = flattenTasks(activeTasks).map((f) => f.task)

    const t = today()

    for (let week = 0; week < 6; week++) {
      const weekStart = gridStart.add({ days: week * 7 })
      const weekEnd = gridStart.add({ days: week * 7 + 6 })
      const weekRow = grid.createDiv('pm-calendar-week-row')

      // Backdrop cells (date numbers + drop targets + today/weekend marks).
      for (let d = 0; d < 7; d++) {
        const date = weekStart.add({ days: d })
        this.renderCell(weekRow, date, t)
      }

      // Continuous bars overlay — one bar per (task, week-segment), spanning
      // the columns the task covers within this week. Lane-packed to avoid
      // visual overlap.
      this.renderWeekBars(weekRow, weekStart, weekEnd, flatTasks)
    }
  }

  private renderCell(
    row: HTMLElement,
    date: Temporal.PlainDate,
    nowDate: Temporal.PlainDate
  ): void {
    const cell = row.createDiv('pm-calendar-cell')
    if (date.month !== this.currentMonth.month) cell.addClass('pm-calendar-cell-other')
    if (date.equals(nowDate)) cell.addClass('pm-calendar-cell-today')
    if (date.dayOfWeek === 6 || date.dayOfWeek === 7) cell.addClass('pm-calendar-cell-weekend')

    const head = cell.createDiv('pm-calendar-cell-head')
    head.createSpan({ cls: 'pm-calendar-date', text: String(date.day) })

    // Drop target: receives bar drags, shifts the task by the offset between
    // its anchor date (carried in the payload) and this cell's date.
    cell.addEventListener('dragover', (e: DragEvent) => {
      e.preventDefault()
      cell.addClass('pm-calendar-cell--drop-target')
    })
    cell.addEventListener('dragleave', () => {
      cell.removeClass('pm-calendar-cell--drop-target')
    })
    cell.addEventListener(
      'drop',
      safeAsync(async (e: DragEvent) => {
        e.preventDefault()
        cell.removeClass('pm-calendar-cell--drop-target')
        const raw = e.dataTransfer?.getData('application/x-pm-task')
        if (!raw) return
        let parsed: { taskId: string; sourceDate: string }
        try {
          parsed = JSON.parse(raw) as { taskId: string; sourceDate: string }
        } catch {
          return
        }
        const task = findTask(this.project.tasks, parsed.taskId)
        if (!task) return
        const sourceDate = parsePlainDate(parsed.sourceDate)
        if (!sourceDate) return
        const offsetDays = date.since(sourceDate, { largestUnit: 'days' }).days
        if (offsetDays === 0) return
        const newStart = task.start
          ? parsePlainDate(task.start)?.add({ days: offsetDays }).toString() ?? task.start
          : task.start
        const newDue = task.due
          ? parsePlainDate(task.due)?.add({ days: offsetDays }).toString() ?? task.due
          : task.due
        await this.plugin.store.updateTask(this.project, task.id, { start: newStart, due: newDue })
        await this.onRefresh()
      })
    )
  }

  /**
   * For a single week (Mon–Sun) compute the visible segment of every task
   * whose [lo, hi] range intersects this week, lane-pack them to avoid
   * vertical overlap, and render each as a single continuous bar.
   */
  private renderWeekBars(
    weekRow: HTMLElement,
    weekStart: Temporal.PlainDate,
    weekEnd: Temporal.PlainDate,
    tasks: Task[]
  ): void {
    interface Seg {
      task: Task
      lo: Temporal.PlainDate
      hi: Temporal.PlainDate
      startCol: number // 1..7
      endCol: number // 2..8 (CSS grid end-line, exclusive)
      continuesLeft: boolean
      continuesRight: boolean
    }

    const segments: Seg[] = []
    for (const task of tasks) {
      const start = parsePlainDate(task.start)
      const due = parsePlainDate(task.due)
      if (!start && !due) continue
      const lo = (start ?? due) as Temporal.PlainDate
      const hi = (due ?? start) as Temporal.PlainDate
      if (Temporal.PlainDate.compare(hi, weekStart) < 0) continue
      if (Temporal.PlainDate.compare(lo, weekEnd) > 0) continue
      const segLo = Temporal.PlainDate.compare(lo, weekStart) >= 0 ? lo : weekStart
      const segHi = Temporal.PlainDate.compare(hi, weekEnd) <= 0 ? hi : weekEnd
      const startCol = weekStart.until(segLo, { largestUnit: 'days' }).days + 1
      const endCol = weekStart.until(segHi, { largestUnit: 'days' }).days + 2
      segments.push({
        task,
        lo,
        hi,
        startCol,
        endCol,
        continuesLeft: Temporal.PlainDate.compare(lo, weekStart) < 0,
        continuesRight: Temporal.PlainDate.compare(hi, weekEnd) > 0
      })
    }

    if (segments.length === 0) return

    // Lane pack — greedy by start column.
    segments.sort((a, b) => a.startCol - b.startCol || a.task.title.localeCompare(b.task.title))
    const laneEnds: number[] = [] // laneEnds[i] = first free column in lane i (exclusive)
    const laneOf: number[] = []
    for (const seg of segments) {
      let lane = laneEnds.findIndex((end) => end <= seg.startCol)
      if (lane === -1) {
        lane = laneEnds.length
        laneEnds.push(seg.endCol)
      } else {
        laneEnds[lane] = seg.endCol
      }
      laneOf.push(lane)
    }

    const overlay = weekRow.createDiv('pm-calendar-bars-overlay')
    segments.forEach((seg, i) => {
      this.renderBar(overlay, seg, laneOf[i])
    })
  }

  private renderBar(
    overlay: HTMLElement,
    seg: {
      task: Task
      lo: Temporal.PlainDate
      hi: Temporal.PlainDate
      startCol: number
      endCol: number
      continuesLeft: boolean
      continuesRight: boolean
    },
    lane: number
  ): void {
    const { task, lo, startCol, endCol, continuesLeft, continuesRight } = seg
    const status = getStatusConfig(this.plugin.settings.statuses, task.status)
    const color = status?.color ?? COLOR_ACCENT

    const bar = overlay.createDiv('pm-calendar-bar')
    bar.style.gridColumn = `${startCol} / ${endCol}`
    bar.style.gridRow = String(lane + 1)
    bar.style.backgroundColor = color
    if (continuesLeft) bar.addClass('pm-calendar-bar--continues-left')
    if (continuesRight) bar.addClass('pm-calendar-bar--continues-right')
    // Show the title only on the first visible segment (where the bar
    // actually starts). Continuation segments stay blank so the eye reads
    // the run as one task without label repetition.
    if (!continuesLeft) bar.setText(task.title)

    bar.title = `${task.title}\n${status?.label ?? task.status}\nStart: ${task.start || '—'}  Due: ${task.due || '—'}`

    // Drag — anchor is the task's actual start (or due if no start), so
    // dropping on a cell intuitively means "make this start on that day".
    const anchor = parsePlainDate(task.start) ?? lo
    bar.draggable = true
    bar.addEventListener('dragstart', (e: DragEvent) => {
      const payload = JSON.stringify({ taskId: task.id, sourceDate: anchor.toString() })
      e.dataTransfer?.setData('application/x-pm-task', payload)
      e.dataTransfer?.setData('text/plain', task.title)
      bar.addClass('pm-calendar-bar--dragging')
    })
    bar.addEventListener('dragend', () => bar.removeClass('pm-calendar-bar--dragging'))

    bar.addEventListener('click', (e: MouseEvent) => {
      e.stopPropagation()
      openTaskModal(this.plugin, this.project, {
        task,
        onSave: async (updated) => {
          await this.plugin.store.updateTask(this.project, task.id, updated)
          await this.onRefresh()
        }
      })
    })
  }
}
