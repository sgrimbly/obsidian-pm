import { ButtonComponent, Menu } from 'obsidian'
import type PMPlugin from '../../main'
import type { CalendarMode, Project, Task, FilterState } from '../../types'
import { makeDefaultFilter } from '../../types'
import type { SubView } from '../SubView'
import { applyTaskFilterPromote } from '../../store/TaskFilter'
import { flattenTasks, findTask } from '../../store/TaskTreeOps'
import { getStatusConfig, safeAsync } from '../../utils'
import { Temporal, today, parsePlainDate } from '../../dates'
import { openTaskModal } from '../../ui/ModalFactory'

/**
 * Calendar view with three modes:
 *
 * - **Month** (default): 6×7 grid of dates. Continuous bars span multiple
 *   days; per-week segments stack in lanes to avoid overlap. The full
 *   bookend-week padding around the month is shown.
 * - **Week**: a single tall week-row. Same bar layout, more vertical room
 *   per cell (useful when a week has many overlapping tasks).
 * - **Year**: 12 mini-month grids (3×4 layout), each cell coloured by task
 *   density. Click a month label to drill into Month mode; click any day
 *   to jump there. No bars (too small to render meaningfully).
 *
 * Interaction beyond the bars:
 * - Right-click any day cell → `+ Add task here` / `+ Add milestone here`,
 *   opens TaskModal with `start = due = clickedDate` pre-filled.
 * - Hover the date number on any cell → digest tooltip listing every task
 *   active that day (complements bars when many overlap).
 * - Drag a bar onto a different day → shifts task by (drop − anchor) days,
 *   preserving duration. Anchor is the task's actual start date.
 */
export class CalendarView implements SubView {
  private mode: CalendarMode
  private anchor: Temporal.PlainDate
  private cleanupFns: (() => void)[] = []
  private digestEl: HTMLElement | null = null
  private digestTimer: number | null = null

  constructor(
    private container: HTMLElement,
    private project: Project,
    private plugin: PMPlugin,
    private onRefresh: () => Promise<void>,
    private filter: FilterState
  ) {
    this.anchor = today()
    this.mode = this.plugin.settings.projectFilters[this.project.filePath]?.calendarMode ?? 'month'
  }

  destroy(): void {
    for (const fn of this.cleanupFns) fn()
    this.cleanupFns = []
    this.hideDigest()
  }

  render(): void {
    this.destroy()
    this.container.empty()
    this.container.addClass('pm-calendar-view')
    this.renderToolbar()
    if (this.mode === 'month') this.renderMonthGrid()
    else if (this.mode === 'week') this.renderWeekGrid()
    else this.renderYearGrid()
  }

  // ─── Toolbar ────────────────────────────────────────────────────────────
  private renderToolbar(): void {
    const bar = this.container.createDiv('pm-calendar-toolbar')
    new ButtonComponent(bar).setButtonText('◀').onClick(() => this.shift(-1))
    new ButtonComponent(bar).setButtonText('Today').onClick(() => {
      this.anchor = today()
      this.render()
    })
    new ButtonComponent(bar).setButtonText('▶').onClick(() => this.shift(1))

    const label = bar.createEl('span', { cls: 'pm-calendar-month-label' })
    label.textContent = this.periodLabel()

    bar.createEl('span', { cls: 'pm-calendar-sep' })

    const modes: Array<{ id: CalendarMode; label: string }> = [
      { id: 'month', label: 'Month' },
      { id: 'week', label: 'Week' },
      { id: 'year', label: 'Year' }
    ]
    for (const m of modes) {
      const btn = bar.createEl('button', { text: m.label, cls: 'pm-calendar-mode-btn' })
      if (m.id === this.mode) btn.addClass('pm-calendar-mode-btn--active')
      btn.addEventListener('click', () => this.setMode(m.id))
    }
  }

  private periodLabel(): string {
    if (this.mode === 'month') {
      return this.anchor.toLocaleString(undefined, { month: 'long', year: 'numeric' })
    }
    if (this.mode === 'week') {
      const weekStart = this.anchor.subtract({ days: this.anchor.dayOfWeek - 1 })
      const weekEnd = weekStart.add({ days: 6 })
      const sameMonth = weekStart.month === weekEnd.month
      const startStr = weekStart.toLocaleString(undefined, { month: 'short', day: 'numeric' })
      const endStr = sameMonth
        ? String(weekEnd.day)
        : weekEnd.toLocaleString(undefined, { month: 'short', day: 'numeric' })
      return `${startStr} – ${endStr}, ${weekStart.year}`
    }
    return String(this.anchor.year)
  }

  private shift(delta: number): void {
    if (this.mode === 'month') {
      this.anchor = this.anchor.add({ months: delta })
    } else if (this.mode === 'week') {
      this.anchor = this.anchor.add({ days: delta * 7 })
    } else {
      this.anchor = this.anchor.add({ years: delta })
    }
    this.render()
  }

  private setMode(mode: CalendarMode): void {
    if (mode === this.mode) return
    this.mode = mode
    void this.persistMode()
    this.render()
  }

  private async persistMode(): Promise<void> {
    if (!this.project.filePath) return
    const existing = this.plugin.settings.projectFilters[this.project.filePath] ?? {
      filter: makeDefaultFilter(),
      activeSavedViewId: null
    }
    this.plugin.settings.projectFilters[this.project.filePath] = {
      ...existing,
      calendarMode: this.mode === 'month' ? undefined : this.mode
    }
    await this.plugin.saveSettings()
  }

  // ─── Month grid (6×7) ──────────────────────────────────────────────────
  private renderMonthGrid(): void {
    const grid = this.container.createDiv('pm-calendar-grid')
    this.appendDowRow(grid)

    const firstOfMonth = Temporal.PlainDate.from({
      year: this.anchor.year,
      month: this.anchor.month,
      day: 1
    })
    const offset = firstOfMonth.dayOfWeek - 1
    const gridStart = firstOfMonth.subtract({ days: offset })

    const flatTasks = this.getFilteredTasks()
    const t = today()

    for (let week = 0; week < 6; week++) {
      const weekStart = gridStart.add({ days: week * 7 })
      const weekEnd = gridStart.add({ days: week * 7 + 6 })
      const weekRow = grid.createDiv('pm-calendar-week-row')
      for (let d = 0; d < 7; d++) {
        const date = weekStart.add({ days: d })
        this.renderCell(weekRow, date, t, this.anchor.month, flatTasks)
      }
      this.renderWeekBars(weekRow, weekStart, weekEnd, flatTasks)
    }
  }

  // ─── Week grid (1×7, tall) ───────────────────────────────────────────────
  private renderWeekGrid(): void {
    const grid = this.container.createDiv('pm-calendar-grid pm-calendar-grid--week')
    this.appendDowRow(grid)

    const weekStart = this.anchor.subtract({ days: this.anchor.dayOfWeek - 1 })
    const weekEnd = weekStart.add({ days: 6 })

    const flatTasks = this.getFilteredTasks()
    const t = today()

    const weekRow = grid.createDiv('pm-calendar-week-row pm-calendar-week-row--tall')
    for (let d = 0; d < 7; d++) {
      const date = weekStart.add({ days: d })
      this.renderCell(weekRow, date, t, this.anchor.month, flatTasks)
    }
    this.renderWeekBars(weekRow, weekStart, weekEnd, flatTasks)
  }

  // ─── Year grid (12 mini months) ─────────────────────────────────────────
  private renderYearGrid(): void {
    const grid = this.container.createDiv('pm-calendar-year-grid')
    const flatTasks = this.getFilteredTasks()
    const t = today()

    // Pre-compute task counts per date for density colouring.
    const counts = new Map<string, number>()
    for (const task of flatTasks) {
      const start = parsePlainDate(task.start)
      const due = parsePlainDate(task.due)
      if (!start && !due) continue
      const lo = (start ?? due) as Temporal.PlainDate
      const hi = (due ?? start) as Temporal.PlainDate
      let d = lo
      while (Temporal.PlainDate.compare(d, hi) <= 0) {
        const key = d.toString()
        counts.set(key, (counts.get(key) ?? 0) + 1)
        d = d.add({ days: 1 })
      }
    }

    let maxCount = 0
    for (const c of counts.values()) if (c > maxCount) maxCount = c

    for (let month = 1; month <= 12; month++) {
      this.renderMiniMonth(grid, this.anchor.year, month, counts, maxCount, t)
    }
  }

  private renderMiniMonth(
    grid: HTMLElement,
    year: number,
    month: number,
    counts: Map<string, number>,
    maxCount: number,
    nowDate: Temporal.PlainDate
  ): void {
    const wrap = grid.createDiv('pm-calendar-mini-month')
    const header = wrap.createDiv('pm-calendar-mini-header')
    header.textContent = Temporal.PlainDate.from({ year, month, day: 1 }).toLocaleString(undefined, { month: 'long' })
    header.addEventListener('click', () => {
      this.anchor = Temporal.PlainDate.from({ year, month, day: 1 })
      this.setMode('month')
    })

    const grid7 = wrap.createDiv('pm-calendar-mini-grid')
    for (const dow of ['M', 'T', 'W', 'T', 'F', 'S', 'S']) {
      grid7.createDiv('pm-calendar-mini-dow').setText(dow)
    }
    const first = Temporal.PlainDate.from({ year, month, day: 1 })
    const offset = first.dayOfWeek - 1
    const gridStart = first.subtract({ days: offset })
    for (let i = 0; i < 42; i++) {
      const date = gridStart.add({ days: i })
      const inMonth = date.month === month
      const dayCell = grid7.createDiv('pm-calendar-mini-day')
      dayCell.setText(inMonth ? String(date.day) : '')
      if (!inMonth) dayCell.addClass('pm-calendar-mini-day--other')
      if (date.equals(nowDate)) dayCell.addClass('pm-calendar-mini-day--today')
      const count = counts.get(date.toString()) ?? 0
      if (count > 0 && maxCount > 0) {
        const intensity = Math.min(1, count / maxCount)
        dayCell.style.setProperty('--pm-mini-density', String(intensity))
        dayCell.addClass('pm-calendar-mini-day--has-tasks')
        dayCell.title = `${count} task${count === 1 ? '' : 's'} on ${date.toString()}`
      }
      dayCell.addEventListener('click', () => {
        this.anchor = date
        this.setMode('month')
      })
    }
  }

  // ─── Day-of-week header row ─────────────────────────────────────────────
  private appendDowRow(grid: HTMLElement): void {
    const dowRow = grid.createDiv('pm-calendar-dow-row')
    for (const dow of ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']) {
      dowRow.createDiv('pm-calendar-dow').setText(dow)
    }
  }

  // ─── Single cell (date number, drop target, right-click menu) ──────────
  private renderCell(
    row: HTMLElement,
    date: Temporal.PlainDate,
    nowDate: Temporal.PlainDate,
    inMonthMonth: number,
    allTasks: Task[]
  ): void {
    const cell = row.createDiv('pm-calendar-cell')
    if (this.mode === 'month' && date.month !== inMonthMonth) {
      cell.addClass('pm-calendar-cell-other')
    }
    if (date.equals(nowDate)) cell.addClass('pm-calendar-cell-today')
    if (date.dayOfWeek === 6 || date.dayOfWeek === 7) cell.addClass('pm-calendar-cell-weekend')

    const head = cell.createDiv('pm-calendar-cell-head')
    const dateEl = head.createSpan({ cls: 'pm-calendar-date', text: String(date.day) })

    // Hover digest: tasks active on this date
    dateEl.addEventListener('mouseenter', () => this.showDigestFor(date, dateEl, allTasks))
    dateEl.addEventListener('mouseleave', () => this.hideDigest())

    // Drag-drop target (bar drag)
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
          ? (parsePlainDate(task.start)?.add({ days: offsetDays }).toString() ?? task.start)
          : task.start
        const newDue = task.due
          ? (parsePlainDate(task.due)?.add({ days: offsetDays }).toString() ?? task.due)
          : task.due
        await this.plugin.store.updateTask(this.project, task.id, { start: newStart, due: newDue })
        await this.onRefresh()
      })
    )

    // Right-click → create a task or milestone starting on this day
    cell.addEventListener('contextmenu', (e: MouseEvent) => {
      const target = e.target as HTMLElement
      if (target.closest('.pm-calendar-bar')) return // bar has its own future menu
      e.preventDefault()
      const menu = new Menu()
      const iso = date.toString()
      menu.addItem((item) =>
        item
          .setTitle('+ add task here')
          .setIcon('plus-circle')
          .onClick(() => this.openCreate(iso, 'task'))
      )
      menu.addItem((item) =>
        item
          .setTitle('+ add milestone here')
          .setIcon('flag')
          .onClick(() => this.openCreate(iso, 'milestone'))
      )
      menu.showAtMouseEvent(e)
    })
  }

  private openCreate(iso: string, type: 'task' | 'milestone'): void {
    openTaskModal(this.plugin, this.project, {
      defaults: { start: iso, due: iso, type },
      onSave: async () => {
        await this.onRefresh()
      }
    })
  }

  /**
   * Hover digest panel — small floating tooltip listing every task active
   * on the hovered date. Complements the bars (which only label the first
   * visible segment) and the bar tooltips (which only show one task at a
   * time). Shows after a 300 ms delay so brief mouse-overs don't flash it.
   */
  private showDigestFor(date: Temporal.PlainDate, anchor: HTMLElement, tasks: Task[]): void {
    this.hideDigest()
    this.digestTimer = window.setTimeout(() => {
      const active = tasks.filter((t) => taskCoversDate(t, date))
      if (active.length === 0) return
      const digest = this.container.ownerDocument.body.createDiv('pm-calendar-digest')
      digest.createDiv({
        cls: 'pm-calendar-digest-date',
        text: date.toLocaleString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })
      })
      const list = digest.createDiv('pm-calendar-digest-list')
      for (const task of active) {
        const status = getStatusConfig(this.plugin.settings.statuses, task.status)
        const row = list.createDiv('pm-calendar-digest-row')
        const dot = row.createSpan({ cls: 'pm-calendar-digest-dot' })
        dot.style.backgroundColor = status?.color ?? 'var(--interactive-accent)'
        row.createSpan({ cls: 'pm-calendar-digest-title', text: task.title })
      }
      const rect = anchor.getBoundingClientRect()
      digest.addClass('pm-calendar-digest-floating')
      digest.setCssProps({
        '--pm-calendar-digest-top': `${rect.bottom + 4}px`,
        '--pm-calendar-digest-left': `${rect.left}px`
      })
      this.digestEl = digest
    }, 300)
  }

  private hideDigest(): void {
    if (this.digestTimer !== null) {
      window.clearTimeout(this.digestTimer)
      this.digestTimer = null
    }
    if (this.digestEl) {
      this.digestEl.remove()
      this.digestEl = null
    }
  }

  // ─── Bar rendering (continuous, lane-packed, per week) ──────────────────
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
      startCol: number
      endCol: number
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

    segments.sort((a, b) => a.startCol - b.startCol || a.task.title.localeCompare(b.task.title))
    const laneEnds: number[] = []
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
    segments.forEach((seg, i) => this.renderBar(overlay, seg, laneOf[i]))
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
    const color = status?.color ?? 'var(--interactive-accent)'

    const bar = overlay.createDiv('pm-calendar-bar')
    bar.style.gridColumn = `${startCol} / ${endCol}`
    bar.style.gridRow = String(lane + 1)
    bar.style.backgroundColor = color
    if (continuesLeft) bar.addClass('pm-calendar-bar--continues-left')
    if (continuesRight) bar.addClass('pm-calendar-bar--continues-right')
    if (!continuesLeft) bar.setText(task.title)
    bar.title = `${task.title}\n${status?.label ?? task.status}\nStart: ${task.start || '—'}  Due: ${task.due || '—'}`

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

  // ─── Helpers ────────────────────────────────────────────────────────────
  private getFilteredTasks(): Task[] {
    const active = applyTaskFilterPromote(this.project.tasks, this.filter, this.plugin.settings.statuses)
    return flattenTasks(active).map((f) => f.task)
  }
}

function taskCoversDate(task: Task, date: Temporal.PlainDate): boolean {
  const start = parsePlainDate(task.start)
  const due = parsePlainDate(task.due)
  if (!start && !due) return false
  const lo = start ?? due
  const hi = due ?? start
  if (!lo || !hi) return false
  return Temporal.PlainDate.compare(date, lo) >= 0 && Temporal.PlainDate.compare(date, hi) <= 0
}
