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
 * - 6-row × 7-column grid of dates (always shows the full month plus
 *   the surrounding-week padding).
 * - Each cell shows a date number plus a list of "chips" for tasks
 *   whose [start, due] range covers that date.
 * - Chips are draggable: dropping a chip on a different date shifts
 *   the task's start/due by the offset between the source and target
 *   date, preserving duration.
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
      const weekRow = grid.createDiv('pm-calendar-week-row')
      for (let d = 0; d < 7; d++) {
        const date = gridStart.add({ days: week * 7 + d })
        this.renderCell(weekRow, date, flatTasks, t)
      }
    }
  }

  private renderCell(
    row: HTMLElement,
    date: Temporal.PlainDate,
    tasks: Task[],
    nowDate: Temporal.PlainDate
  ): void {
    const cell = row.createDiv('pm-calendar-cell')
    if (date.month !== this.currentMonth.month) cell.addClass('pm-calendar-cell-other')
    if (date.equals(nowDate)) cell.addClass('pm-calendar-cell-today')
    if (date.dayOfWeek === 6 || date.dayOfWeek === 7) cell.addClass('pm-calendar-cell-weekend')

    const head = cell.createDiv('pm-calendar-cell-head')
    head.createSpan({ cls: 'pm-calendar-date', text: String(date.day) })

    const chipBox = cell.createDiv('pm-calendar-chips')

    // Tasks covering this date.
    for (const task of tasks) {
      if (taskCoversDate(task, date)) this.renderChip(chipBox, task, date)
    }

    // Allow dropping a chip onto this cell to reschedule.
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

  private renderChip(container: HTMLElement, task: Task, cellDate: Temporal.PlainDate): void {
    const status = getStatusConfig(this.plugin.settings.statuses, task.status)
    const color = status?.color ?? COLOR_ACCENT
    const chip = container.createDiv('pm-calendar-chip')
    chip.style.backgroundColor = color
    chip.setText(task.title)
    chip.title = `${task.title}\n${status?.label ?? task.status}\nStart: ${task.start || '—'}  Due: ${task.due || '—'}`

    chip.draggable = true
    chip.addEventListener('dragstart', (e: DragEvent) => {
      const payload = JSON.stringify({ taskId: task.id, sourceDate: cellDate.toString() })
      e.dataTransfer?.setData('application/x-pm-task', payload)
      e.dataTransfer?.setData('text/plain', task.title)
      chip.addClass('pm-calendar-chip--dragging')
    })
    chip.addEventListener('dragend', () => chip.removeClass('pm-calendar-chip--dragging'))

    chip.addEventListener('click', (e: MouseEvent) => {
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

function taskCoversDate(task: Task, date: Temporal.PlainDate): boolean {
  const start = parsePlainDate(task.start)
  const due = parsePlainDate(task.due)
  if (!start && !due) return false
  const lo = start ?? due!
  const hi = due ?? start!
  return Temporal.PlainDate.compare(date, lo) >= 0 && Temporal.PlainDate.compare(date, hi) <= 0
}
