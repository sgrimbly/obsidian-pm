import { MarkdownRenderChild, TFile } from 'obsidian'
import type PMPlugin from '../main'
import { type FilterState, type Project, type ViewMode, makeDefaultFilter } from '../types'
import { safeAsync } from '../utils'
import type { SubView } from '../views/SubView'
import { GanttView } from '../views/gantt/GanttView'
import { KanbanView } from '../views/KanbanView'
import { CalendarView } from '../views/calendar/CalendarView'
import { TableView } from '../views/table/TableView'
import type { EmbedConfig } from './parseEmbedConfig'

const RELOAD_DEBOUNCE_MS = 300

/**
 * Render a single `pm-gantt` / `pm-table` / `pm-kanban` / `pm-calendar`
 * code block. Loads the referenced project, mounts the corresponding
 * SubView into the codeblock element, and re-renders when the underlying
 * project or task files change.
 */
export class CodeBlockEmbed extends MarkdownRenderChild {
  private subview: SubView | null = null
  private reloadDebounceTimer: number | null = null
  private viewportEl: HTMLElement | null = null

  constructor(
    containerEl: HTMLElement,
    private plugin: PMPlugin,
    private config: EmbedConfig,
    private defaultView: ViewMode
  ) {
    super(containerEl)
  }

  override onload(): void {
    this.containerEl.empty()
    this.containerEl.addClass('pm-embed')
    this.containerEl.style.setProperty('--pm-embed-height', `${this.config.height}px`)

    this.viewportEl = this.containerEl.createDiv('pm-embed-viewport')
    this.viewportEl.style.height = `${this.config.height}px`

    this.registerEvent(
      this.plugin.app.vault.on('modify', (file) => {
        if (!(file instanceof TFile) || !this.fileIsRelevant(file.path)) return
        this.scheduleReload()
      })
    )
    this.registerEvent(
      this.plugin.app.vault.on(
        'delete',
        safeAsync(async (file) => {
          if (this.fileIsRelevant(file.path)) await this.renderProject()
        })
      )
    )

    void this.renderProject()
  }

  override onunload(): void {
    if (this.reloadDebounceTimer !== null) {
      activeWindow.clearTimeout(this.reloadDebounceTimer)
      this.reloadDebounceTimer = null
    }
    this.subview?.destroy?.()
    this.subview = null
  }

  private fileIsRelevant(path: string): boolean {
    const taskFolder = this.config.file.replace(/\.md$/, '_tasks')
    return path === this.config.file || path.startsWith(taskFolder + '/')
  }

  private scheduleReload(): void {
    if (this.reloadDebounceTimer !== null) activeWindow.clearTimeout(this.reloadDebounceTimer)
    this.reloadDebounceTimer = activeWindow.setTimeout(
      safeAsync(async () => {
        this.reloadDebounceTimer = null
        await this.renderProject()
      }),
      RELOAD_DEBOUNCE_MS
    )
  }

  private async renderProject(): Promise<void> {
    if (!this.viewportEl) return
    const file = this.plugin.app.vault.getAbstractFileByPath(this.config.file)
    if (!(file instanceof TFile)) {
      this.renderError(`File not found in vault: ${this.config.file}`)
      return
    }
    const project = await this.plugin.store.loadProject(file)
    if (!project) {
      this.renderError(`Could not parse a project from ${this.config.file}. Check that the file has \`pm-project: true\` in its frontmatter.`)
      return
    }
    this.mountSubview(project)
  }

  private mountSubview(project: Project): void {
    if (!this.viewportEl) return
    this.subview?.destroy?.()
    this.viewportEl.empty()

    const filter = this.resolveFilter(project.filePath)
    const onRefresh = async (): Promise<void> => {
      await this.renderProject()
    }

    const kind: ViewMode = this.config.view ?? this.defaultView

    const savedGranularity = this.plugin.settings.ganttGranularity
    if (kind === 'gantt' && this.config.granularity) {
      // GanttView reads the granularity setting in its constructor, so apply
      // it just for this construction and restore it immediately. The user's
      // global default isn't permanently changed; if they click a zoom button
      // inside the embed the setting will be saved as usual.
      this.plugin.settings.ganttGranularity = this.config.granularity
    }

    try {
      switch (kind) {
        case 'gantt':
          this.subview = new GanttView(this.viewportEl, project, this.plugin, onRefresh, filter)
          break
        case 'kanban':
          this.subview = new KanbanView(this.viewportEl, project, this.plugin, onRefresh, filter)
          break
        case 'calendar':
          this.subview = new CalendarView(this.viewportEl, project, this.plugin, onRefresh, filter)
          break
        case 'table':
          this.subview = new TableView(this.viewportEl, project, this.plugin, onRefresh, filter)
          break
      }
    } finally {
      this.plugin.settings.ganttGranularity = savedGranularity
    }

    this.subview?.render()
  }

  private resolveFilter(filePath: string): FilterState {
    const saved = this.plugin.settings.projectFilters[filePath]
    return saved ? saved.filter : makeDefaultFilter()
  }

  private renderError(msg: string): void {
    if (!this.viewportEl) return
    this.subview?.destroy?.()
    this.subview = null
    this.viewportEl.empty()
    this.viewportEl.addClass('pm-embed-error')
    this.viewportEl.createEl('div', { text: 'Project manager embed error', cls: 'pm-embed-error-title' })
    this.viewportEl.createEl('div', { text: msg, cls: 'pm-embed-error-msg' })
  }
}
