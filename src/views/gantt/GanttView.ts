import { ButtonComponent } from 'obsidian'
import type PMPlugin from '../../main'
import type { Project, Task, GanttGranularity, GanttSortMode, FilterState } from '../../types'
import { makeDefaultFilter } from '../../types'
import { type FlatTask, flattenTasks, sortTaskTree } from '../../store/TaskTreeOps'
import { applyTaskFilterPromote } from '../../store/TaskFilter'
import { openTaskModal } from '../../ui/ModalFactory'
import type { SubView } from '../SubView'
import type { TimelineCfg } from './TimelineConfig'
import { buildTimelineConfig, dateToX, xToDate, HEADER_HEIGHT, ROW_HEIGHT, LABEL_WIDTH } from './TimelineConfig'
import { makeDragState } from './GanttDragHandler'
import type { DragState } from './GanttDragHandler'
import { makeLinkState, cancelLink } from './GanttLinkHandler'
import type { LinkState } from './GanttLinkHandler'
import {
  renderTimelineHeader,
  renderGridLines,
  renderTodayLine,
  renderTaskBar,
  renderDependencyArrows,
  renderMilestoneLabels
} from './GanttRenderer'
import { svgEl } from '../../utils'
import { Temporal, today } from '../../dates'
import type { RendererContext } from './GanttRenderer'
import { renderTaskLabel } from './TaskLabelRenderer'

export class GanttView implements SubView {
  private granularity: GanttGranularity
  private scrollEl!: HTMLElement
  private svgEl!: SVGSVGElement
  private flatTasks: FlatTask[] = []
  private cfg!: TimelineCfg
  private drag: DragState = makeDragState()
  private link: LinkState = makeLinkState()
  private labelWidth: number = LABEL_WIDTH
  private labelPanelHidden: boolean = false

  getLabelWidth(): number {
    return this.labelPanelHidden ? 0 : this.labelWidth
  }
  setLabelWidth(w: number): void {
    this.labelWidth = w
  }
  private cleanupFns: (() => void)[] = []
  private pendingScroll: { top: number; anchorDate: Temporal.PlainDate } | null = null

  constructor(
    private container: HTMLElement,
    private project: Project,
    private plugin: PMPlugin,
    private onRefresh: () => Promise<void>,
    private filter: FilterState
  ) {
    this.granularity = plugin.settings.ganttGranularity
  }

  destroy(): void {
    for (const fn of this.cleanupFns) fn()
    this.cleanupFns = []
  }

  getScrollPosition(): { top: number; anchorDate: Temporal.PlainDate } {
    const top = this.scrollEl?.scrollTop ?? 0
    const anchorDate = this.scrollEl ? xToDate(this.cfg, this.scrollEl.scrollLeft) : today()
    return { top, anchorDate }
  }

  setPendingScroll(pos: { top: number; anchorDate: Temporal.PlainDate }): void {
    this.pendingScroll = pos
  }

  refresh(): void {
    this.pendingScroll = this.getScrollPosition()
    this.render()
  }

  render(): void {
    this.cleanupFns.forEach((fn) => fn())
    this.cleanupFns = []
    cancelLink(this.link)
    this.container.empty()
    this.container.addClass('pm-gantt-view')

    const activeTasks = this.getVisibleTasks()
    this.flatTasks = flattenTasks(activeTasks).filter((f) => f.visible || f.depth === 0)
    this.cfg = buildTimelineConfig(activeTasks, this.granularity)

    this.renderGranularityControls()
    this.renderGantt()
  }

  private renderGranularityControls(): void {
    const bar = this.container.createDiv('pm-gantt-controls')
    const levels: GanttGranularity[] = ['day', 'week', 'month', 'quarter', 'year']
    const labels: Record<GanttGranularity, string> = {
      day: 'Day',
      week: 'Week',
      month: 'Month',
      quarter: 'Quarter',
      year: 'Year'
    }

    for (const level of levels) {
      const btn = bar.createEl('button', { text: labels[level], cls: 'pm-gantt-zoom-btn' })
      if (level === this.granularity) btn.addClass('pm-gantt-zoom-btn--active')
      btn.addEventListener('click', () => {
        this.granularity = level
        this.plugin.settings.ganttGranularity = level
        void this.plugin.saveSettings()
        this.render()
      })
    }

    bar.createSpan({ cls: 'pm-gantt-sep' })
    new ButtonComponent(bar).setButtonText('Today').onClick(() => this.scrollToToday())

    new ButtonComponent(bar).setButtonText('Expand all').onClick(() => this.setAllCollapsed(false))
    new ButtonComponent(bar).setButtonText('Collapse all').onClick(() => this.setAllCollapsed(true))

    // Row sort: view-only overlay on top of natural (taskIds) order.
    bar.createEl('span', { cls: 'pm-gantt-sep' })
    bar.createEl('span', { text: 'Sort:', cls: 'pm-gantt-sort-label' })
    const sortSelect = bar.createEl('select', { cls: 'pm-gantt-sort-select' })
    const sortOptions: Array<{ value: GanttSortMode; label: string }> = [
      { value: 'natural', label: 'Natural' },
      { value: 'start-asc', label: 'Start ↑' },
      { value: 'start-desc', label: 'Start ↓' },
      { value: 'due-asc', label: 'Due ↑' },
      { value: 'due-desc', label: 'Due ↓' }
    ]
    const currentSort = this.getSortMode()
    for (const opt of sortOptions) {
      const optionEl = sortSelect.createEl('option', { text: opt.label, value: opt.value })
      if (opt.value === currentSort) optionEl.selected = true
    }
    sortSelect.addEventListener('change', () => {
      this.setSortMode(sortSelect.value as GanttSortMode)
    })
  }

  private toggleLabelPanel(): void {
    this.labelPanelHidden = !this.labelPanelHidden
    this.render()
  }

  private renderGantt(): void {
    const wrapper = this.container.createDiv('pm-gantt-wrapper')

    // Left panel: task labels (hidden when labelPanelHidden is true)
    const leftPanel = wrapper.createDiv('pm-gantt-left')
    if (this.labelPanelHidden) {
      leftPanel.addClass('pm-gantt-left--hidden')
    } else {
      leftPanel.style.width = `${this.labelWidth}px`
      leftPanel.style.minWidth = `${this.labelWidth}px`
    }
    const leftHeader = leftPanel.createDiv('pm-gantt-left-header')
    leftHeader.style.height = `${HEADER_HEIGHT}px`
    leftHeader.createSpan({ text: 'Task', cls: 'pm-gantt-left-header-label' })
    // Collapse chevron at the right edge of the task-list header (Notion-style).
    const collapseBtn = leftHeader.createEl('button', {
      cls: 'pm-gantt-collapse-btn',
      attr: { 'aria-label': 'Hide table', title: 'Hide table' }
    })
    collapseBtn.textContent = '«' // « (double left-angle)
    collapseBtn.addEventListener('click', () => this.toggleLabelPanel())
    const leftBody = leftPanel.createDiv('pm-gantt-left-body')

    // Resize handle (hidden when label panel is collapsed)
    const resizeHandle = wrapper.createDiv('pm-gantt-resize-handle')
    if (this.labelPanelHidden) resizeHandle.addClass('pm-gantt-resize-handle--hidden')
    let resizing = false
    let startX = 0
    let startWidth = 0
    // Scope to the panel's own document so this works in inline embeds too
    // (where the embed's host note may not be the active workspace leaf).
    const resizeDoc = leftPanel.ownerDocument
    resizeHandle.addEventListener('mousedown', (e: MouseEvent) => {
      e.preventDefault()
      resizing = true
      startX = e.clientX
      startWidth = this.labelWidth
      resizeDoc.body.addClass('pm-resize-active')
    })
    const onMouseMove = (e: MouseEvent) => {
      if (!resizing) return
      const newWidth = Math.max(150, Math.min(600, startWidth + (e.clientX - startX)))
      this.labelWidth = newWidth
      leftPanel.style.width = `${newWidth}px`
      leftPanel.style.minWidth = `${newWidth}px`
    }
    const onMouseUp = () => {
      if (!resizing) return
      resizing = false
      resizeDoc.body.removeClass('pm-resize-active')
    }
    resizeDoc.addEventListener('mousemove', onMouseMove)
    resizeDoc.addEventListener('mouseup', onMouseUp)
    this.cleanupFns.push(() => {
      resizeDoc.removeEventListener('mousemove', onMouseMove)
      resizeDoc.removeEventListener('mouseup', onMouseUp)
    })

    // Right panel: timeline
    const rightPanel = wrapper.createDiv('pm-gantt-right')
    this.scrollEl = rightPanel
    // When the label panel is hidden, show a small expand chevron pinned to
    // the top-left of the timeline so the user can bring the table back.
    if (this.labelPanelHidden) {
      const expandBtn = rightPanel.createEl('button', {
        cls: 'pm-gantt-expand-btn-floating',
        attr: { 'aria-label': 'Show table', title: 'Show table' }
      })
      expandBtn.textContent = '»' // » (double right-angle)
      expandBtn.addEventListener('click', () => this.toggleLabelPanel())
    }
    const svgContainer = this.scrollEl.createDiv('pm-gantt-svg-container')
    svgContainer.style.width = `${this.cfg.totalWidth}px`

    const totalRows = this.flatTasks.filter((f) => f.visible || f.depth === 0).length
    const svgHeight = HEADER_HEIGHT + (totalRows + 1) * ROW_HEIGHT // +1 for add-task row

    this.svgEl = svgEl('svg', {
      width: this.cfg.totalWidth,
      height: svgHeight,
      class: 'pm-gantt-svg'
    })
    svgContainer.appendChild(this.svgEl)

    // Escape to cancel linking mode; Ctrl/Cmd+Z to undo, Ctrl/Cmd+Shift+Z
    // or Ctrl/Cmd+Y to redo the last drag. Only fire when the gantt view's
    // leaf is the active workspace leaf, so we don't hijack undo/redo while
    // the user is editing an unrelated note.
    const isGanttActive = (): boolean => {
      const leafEl = this.container.closest('.workspace-leaf')
      return leafEl?.classList.contains('mod-active') ?? false
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (!isGanttActive()) return
      if (e.key === 'Escape' && this.link.active) {
        cancelLink(this.link)
      }
      if (this.drag.isDragging) return
      const mod = e.ctrlKey || e.metaKey
      if (!mod) return
      const key = e.key.toLowerCase()
      if (key === 'z' && !e.shiftKey) {
        e.preventDefault()
        void this.plugin.undoLastAction()
      } else if ((key === 'z' && e.shiftKey) || key === 'y') {
        e.preventDefault()
        void this.plugin.redoLastAction()
      }
    }
    activeDocument.addEventListener('keydown', onKeyDown)
    this.cleanupFns.push(() => activeDocument.removeEventListener('keydown', onKeyDown))

    const ctx = this.makeRendererContext()
    renderTimelineHeader(ctx)
    renderGridLines(ctx, totalRows)
    renderTodayLine(ctx, svgHeight)
    this.renderTaskRows(leftBody, ctx)
    renderDependencyArrows(ctx)
    renderMilestoneLabels(ctx)

    // Trackpad wheel events always carry both axes — a "vertical" swipe still
    // produces a small deltaX wobble that, if applied, makes the timeline
    // drift sideways. We classify each event as dominantly horizontal,
    // dominantly vertical, or pure-vertical-with-shift (treated as
    // horizontal). A small deadzone rejects the residual wobble that survives
    // the dominance check on near-pure vertical gestures.
    //
    // For dominantly-vertical events we do not preventDefault on the right
    // panel — the browser handles vertical scroll natively. For the left
    // panel (overflow:hidden) we have to forward deltaY manually, but we
    // still drop the wobbly deltaX.
    const HORIZONTAL_DEADZONE = 2 // px per event; smaller than typical wobble
    const HORIZONTAL_DOMINANCE = 1.5 // |dx| must beat |dy| by this ratio
    const isHorizontalGesture = (e: WheelEvent): boolean => {
      const ax = Math.abs(e.deltaX)
      const ay = Math.abs(e.deltaY)
      return ax > HORIZONTAL_DEADZONE && ax > ay * HORIZONTAL_DOMINANCE
    }

    // Left panel (overflow:hidden) — always forward vertical scroll. Apply
    // horizontal only if the gesture is clearly horizontal.
    const onLeftWheel = (e: WheelEvent) => {
      rightPanel.scrollTop += e.deltaY
      if (isHorizontalGesture(e)) {
        rightPanel.scrollLeft += e.deltaX
      }
      e.preventDefault()
    }
    leftPanel.addEventListener('wheel', onLeftWheel, { passive: false })
    this.cleanupFns.push(() => leftPanel.removeEventListener('wheel', onLeftWheel))

    // Right panel — let the browser do native vertical scroll. We only
    // intercept clearly-horizontal trackpad gestures (to assert ownership
    // before Obsidian's pane-swipe handler) and Shift+wheel (legacy mouse
    // path for horizontal scroll).
    const onRightWheel = (e: WheelEvent) => {
      if (isHorizontalGesture(e)) {
        rightPanel.scrollLeft += e.deltaX
        e.preventDefault()
      } else if (e.shiftKey && e.deltaY !== 0 && e.deltaX === 0) {
        rightPanel.scrollLeft += e.deltaY
        e.preventDefault()
      }
    }
    rightPanel.addEventListener('wheel', onRightWheel, { passive: false })
    this.cleanupFns.push(() => rightPanel.removeEventListener('wheel', onRightWheel))

    // Add task button
    const addRow = leftBody.createDiv('pm-gantt-label-row pm-gantt-add-row')
    addRow.style.height = `${ROW_HEIGHT}px`
    const addBtn = addRow.createEl('button', { text: '+ add task', cls: 'pm-gantt-add-task-btn' })
    addBtn.addEventListener('click', () => {
      openTaskModal(this.plugin, this.project, { onSave: () => this.onRefresh() })
    })

    // Spacer compensates for horizontal scrollbar in the right panel.
    // The scrollbar reduces the right panel's viewport height, letting it
    // scroll further than the left body. Without this, rows desync at the bottom.
    const leftSpacer = leftBody.createDiv()
    leftSpacer.addClass('pm-no-shrink')
    const syncSpacer = () => {
      const hScrollbarH = rightPanel.offsetHeight - rightPanel.clientHeight
      leftSpacer.style.height = `${hScrollbarH}px`
    }

    // Sync vertical scroll: right → left
    rightPanel.addEventListener('scroll', () => {
      syncSpacer()
      leftBody.scrollTop = rightPanel.scrollTop
    })

    window.requestAnimationFrame(() => {
      syncSpacer()
      if (this.pendingScroll) {
        this.scrollEl.scrollTop = this.pendingScroll.top
        this.scrollEl.scrollLeft = Math.max(0, dateToX(this.cfg, this.pendingScroll.anchorDate))
        this.pendingScroll = null
      } else {
        this.scrollToToday()
      }
    })
  }

  private renderTaskRows(leftBody: HTMLElement, ctx: RendererContext): void {
    const barsGroup = svgEl('g', { class: 'pm-gantt-bars' })
    this.svgEl.appendChild(barsGroup)

    const labelCtx = { plugin: this.plugin, project: this.project, onRefresh: this.onRefresh }
    let rowIndex = 0
    const renderFlatList = (tasks: Task[], depth: number) => {
      for (const task of tasks) {
        renderTaskLabel(leftBody, task, depth, rowIndex, labelCtx)
        renderTaskBar(barsGroup, task, rowIndex, depth, ctx)
        rowIndex++
        if (!task.collapsed && task.subtasks.length) {
          renderFlatList(task.subtasks, depth + 1)
        }
      }
    }
    renderFlatList(this.getVisibleTasks(), 0)
  }

  private makeRendererContext(): RendererContext {
    return {
      svgEl: this.svgEl,
      cfg: this.cfg,
      plugin: this.plugin,
      project: this.project,
      flatTasks: this.flatTasks,
      drag: this.drag,
      link: this.link,
      onRefresh: this.onRefresh,
      cleanupFns: this.cleanupFns
    }
  }

  private getVisibleTasks(): Task[] {
    const filtered = applyTaskFilterPromote(this.project.tasks, this.filter, this.plugin.settings.statuses)
    // Apply the per-project Gantt sort overlay. Default 'natural' is a
    // pass-through — project.tasks order (= taskIds order in the project
    // file) is the source of truth; sort is a view-only re-ordering.
    const sortMode = this.getSortMode()
    return sortTaskTree(filtered, sortMode)
  }

  private getSortMode(): GanttSortMode {
    return this.plugin.settings.projectFilters[this.project.filePath]?.ganttSort ?? 'natural'
  }

  private setSortMode(mode: GanttSortMode): void {
    if (!this.plugin.settings.projectFilters[this.project.filePath]) {
      this.plugin.settings.projectFilters[this.project.filePath] = {
        filter: makeDefaultFilter(),
        activeSavedViewId: null
      }
    }
    if (mode === 'natural') {
      delete this.plugin.settings.projectFilters[this.project.filePath].ganttSort
    } else {
      this.plugin.settings.projectFilters[this.project.filePath].ganttSort = mode
    }
    void this.plugin.saveSettings()
    this.render()
  }

  private scrollToToday(): void {
    if (!this.scrollEl) return
    const x = dateToX(this.cfg, today())
    // `ganttTodayPosition` is a 0–1 fraction of viewport width: 0 = today flush
    // left, 0.5 = centred (classic Gantt default), 1 = flush right. The
    // settings slider enforces a sensible 0.05–0.5 range. Lower values expose
    // more of the future to the right, which is what most forward-planning
    // workflows want.
    const fraction = this.plugin.settings.ganttTodayPosition
    const offset = x - this.scrollEl.clientWidth * fraction
    this.scrollEl.scrollLeft = Math.max(0, offset)
  }

  private setAllCollapsed(collapsed: boolean): void {
    for (const { task } of flattenTasks(this.project.tasks)) {
      if (task.subtasks.length > 0) task.collapsed = collapsed
    }
    void this.plugin.persistCollapsedState(this.project)
    this.render()
  }
}
