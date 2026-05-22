import { MarkdownPostProcessorContext, MarkdownView, Plugin, Notice, TFile, WorkspaceLeaf } from 'obsidian'
import { DEFAULT_SETTINGS, PMSettings, Project, ViewMode } from './types'
import { flattenTasks } from './store/TaskTreeOps'
import { ProjectStore } from './store'
import { PMSettingTab } from './settings'
import { ProjectView, PM_PROJECT_VIEW_TYPE } from './views/ProjectView'
import { DashboardView, PM_DASHBOARD_VIEW_TYPE } from './views/DashboardView'
import { PMViewRouter } from './views/PMViewRouter'
import { openProjectModal, openTaskModal, openProjectPicker, openTaskPicker, openImportModal } from './ui/ModalFactory'
import { Notifier } from './components/Notifier'
import { migrateProjects } from './migration'
import { safeAsync } from './utils'
import { parseEmbedConfig } from './embed/parseEmbedConfig'
import { CodeBlockEmbed } from './embed/CodeBlockEmbed'

export default class PMPlugin extends Plugin {
  settings: PMSettings = { ...DEFAULT_SETTINGS }
  store!: ProjectStore
  notifier!: Notifier
  router!: PMViewRouter
  undoStack: Array<{ undo: () => Promise<void>; redo: () => Promise<void> }> = []
  redoStack: Array<{ undo: () => Promise<void>; redo: () => Promise<void> }> = []

  pushUndo(entry: { undo: () => Promise<void>; redo: () => Promise<void> }): void {
    this.undoStack.push(entry)
    if (this.undoStack.length > 20) this.undoStack.shift()
    this.redoStack = []
  }

  async undoLastAction(): Promise<void> {
    const entry = this.undoStack.pop()
    if (entry) {
      await entry.undo()
      this.redoStack.push(entry)
    }
  }

  async redoLastAction(): Promise<void> {
    const entry = this.redoStack.pop()
    if (entry) {
      await entry.redo()
      this.undoStack.push(entry)
    }
  }

  async onload(): Promise<void> {
    await this.loadSettings()
    this.store = new ProjectStore(this.app, () => this.settings.statuses)
    this.notifier = new Notifier(this)
    this.router = new PMViewRouter(this)

    this.registerView(PM_PROJECT_VIEW_TYPE, (leaf) => new ProjectView(leaf, this))
    this.registerView(PM_DASHBOARD_VIEW_TYPE, (leaf) => new DashboardView(leaf, this))

    this.app.workspace.onLayoutReady(
      safeAsync(async () => {
        await migrateProjects(this)
        await this.cleanupStaleProjectFilters()
      })
    )

    this.addRibbonIcon('chart-gantt', 'Project manager', async () => {
      await this.router.openDashboard()
    })

    this.addCommand({
      id: 'open-projects',
      name: 'Open projects pane',
      callback: () => {
        void this.router.openDashboard()
      }
    })

    this.addCommand({
      id: 'new-project',
      name: 'Create new project',
      callback: () => {
        openProjectModal(this, {
          onSave: async (project) => {
            await this.router.openProjectByPath(project.filePath)
          }
        })
      }
    })

    this.addCommand({
      id: 'new-task',
      name: 'Create new task',
      callback: () => {
        void this.pickProjectThenCreateTask(null)
      }
    })

    this.addCommand({
      id: 'new-subtask',
      name: 'Create new subtask',
      callback: () => {
        void this.pickProjectThenCreateTask('pick-parent')
      }
    })

    this.addCommand({
      id: 'undo-last-action',
      name: 'Undo last action',
      callback: () => {
        void this.undoLastAction()
      }
    })

    this.addCommand({
      id: 'redo-last-action',
      name: 'Redo last action',
      callback: () => {
        void this.redoLastAction()
      }
    })

    this.addCommand({
      id: 'import-notes-as-tasks',
      name: 'Import notes as tasks',
      callback: () => {
        void this.importNotes()
      }
    })

    this.addCommand({
      id: 'open-current-as-project',
      name: 'Open current file as project',
      checkCallback: (checking: boolean) => {
        const md = this.app.workspace.getActiveViewOfType(MarkdownView)
        const file = md?.file
        if (!file) return false
        const cache = this.app.metadataCache.getFileCache(file)
        if (cache?.frontmatter?.['pm-project'] !== true) return false
        if (checking) return true
        void md.leaf.setViewState({ type: PM_PROJECT_VIEW_TYPE, state: { filePath: file.path } })
        return true
      }
    })

    this.addCommand({
      id: 'open-current-as-markdown',
      name: 'Open current project as Markdown',
      checkCallback: (checking: boolean) => {
        const projectView = this.app.workspace.getActiveViewOfType(ProjectView)
        if (!projectView) return false
        const filePath = projectView.filePath
        const file = filePath ? this.app.vault.getAbstractFileByPath(filePath) : null
        if (!(file instanceof TFile)) return false
        if (checking) return true
        void this.openAsMarkdown(projectView.leaf, file)
        return true
      }
    })

    // Auto-open project files into the Project view (bookmarkable).
    // Defer with a small delay so Obsidian's own markdown-mount finishes
    // before we override. setTimeout(0) sometimes races with mid-flight
    // render — 50ms gives the markdown view time to settle so our
    // setViewState cleanly replaces it instead of competing.
    this.registerEvent(
      this.app.workspace.on('file-open', (file) => {
        window.setTimeout(() => this.maybeAutoOpenAsProject(file), 50)
      })
    )

    // Inline embeds: `pm-gantt`, `pm-table`, `pm-kanban`, `pm-calendar`.
    // Each renders the corresponding SubView (the same components used inside
    // the full Project view) into the codeblock element, scoped to one
    // project. The configuration body is YAML; `file:` is required.
    const VIEW_BY_LANG: Record<string, ViewMode> = {
      'pm-gantt': 'gantt',
      'pm-table': 'table',
      'pm-kanban': 'kanban',
      'pm-calendar': 'calendar'
    }
    for (const [lang, view] of Object.entries(VIEW_BY_LANG)) {
      this.registerMarkdownCodeBlockProcessor(lang, (source, el, ctx) =>
        this.renderEmbed(source, el, ctx, view)
      )
    }

    this.addSettingTab(new PMSettingTab(this.app, this))
    this.notifier.start()
  }

  private renderEmbed(source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext, defaultView: ViewMode): void {
    const { config, error } = parseEmbedConfig(source)
    if (!config) {
      el.empty()
      el.addClass('pm-embed', 'pm-embed-error')
      el.createEl('div', { text: 'Project manager embed error', cls: 'pm-embed-error-title' })
      el.createEl('div', { text: error ?? 'Unknown error.', cls: 'pm-embed-error-msg' })
      return
    }
    ctx.addChild(new CodeBlockEmbed(el, this, config, defaultView))
  }

  private maybeAutoOpenAsProject(file: TFile | null): void {
    if (!file) return
    if (!this.settings.autoOpenProjects) return
    const cache = this.app.metadataCache.getFileCache(file)
    // Accept boolean true (parsed YAML) or string "true" (edge cases on
    // freshly-modified files where the cache hasn't re-parsed yet).
    const flag = cache?.frontmatter?.['pm-project']
    if (flag !== true && flag !== 'true') return

    // Look for an existing pm-project leaf already rendering this file. If
    // one exists, focus it and close any duplicate markdown leaf Obsidian
    // created.
    let existingProjectLeaf: WorkspaceLeaf | null = null
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (existingProjectLeaf) return
      if (leaf.view.getViewType() !== PM_PROJECT_VIEW_TYPE) return
      const vs = leaf.getViewState().state as Record<string, unknown> | undefined
      if (vs && vs['filePath'] === file.path) existingProjectLeaf = leaf
    })

    const markdownLeaves: WorkspaceLeaf[] = []
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (leaf.view.getViewType() !== 'markdown') return
      const view = leaf.view as MarkdownView
      if (view.file?.path === file.path) markdownLeaves.push(leaf)
    })

    if (existingProjectLeaf) {
      for (const leaf of markdownLeaves) leaf.detach()
      this.app.workspace.revealLeaf(existingProjectLeaf)
      return
    }

    const target = markdownLeaves[0]
    if (!target) return

    // `active: true` forces a full view mount instead of a state-only patch,
    // which has been observed to no-op when the leaf was mid-rendering the
    // previous markdown view. revealLeaf after the await ensures focus.
    // If setViewState resolves but the view type doesn't actually transition
    // (an Obsidian quirk seen in some cases), fall back to detach + reopen
    // via the router, which mirrors the manual "Open current file as project"
    // command's behaviour.
    target
      .setViewState({ type: PM_PROJECT_VIEW_TYPE, state: { filePath: file.path }, active: true })
      .then(() => {
        this.app.workspace.revealLeaf(target)
        if (target.view.getViewType() !== PM_PROJECT_VIEW_TYPE) {
          target.detach()
          void this.router.openProjectByPath(file.path)
        }
      })
      .catch(() => undefined)
  }

  private async openAsMarkdown(leaf: WorkspaceLeaf, file: TFile): Promise<void> {
    // Set autoOpenProjects to false transiently so the file-open hook doesn't
    // immediately yank the leaf back into the Project view.
    const saved = this.settings.autoOpenProjects
    this.settings.autoOpenProjects = false
    try {
      await leaf.setViewState({ type: 'markdown', state: { file: file.path, mode: 'source' } })
    } finally {
      // Restore on next tick so the in-flight file-open event has fired.
      activeWindow.setTimeout(() => {
        this.settings.autoOpenProjects = saved
      }, 0)
    }
  }

  onunload(): void {
    this.notifier.stop()
  }

  async loadSettings(): Promise<void> {
    const saved = (await this.loadData()) as Partial<PMSettings> | null
    this.settings = Object.assign({}, DEFAULT_SETTINGS, saved ?? {})
    if (!saved?.statuses?.length) this.settings.statuses = DEFAULT_SETTINGS.statuses
    if (!saved?.priorities?.length) this.settings.priorities = DEFAULT_SETTINGS.priorities
    if (!this.settings.projectFilters) this.settings.projectFilters = {}

    let migrated = false
    for (const s of this.settings.statuses) {
      if (s.complete === undefined) {
        s.complete = s.id === 'done' || s.id === 'cancelled'
        migrated = true
      }
    }

    // ganttHideDone was a global gantt toggle; replaced by per-project filter.statuses
    // excluding terminal statuses. Seed projects whose filter has no status selection yet.
    const legacy = (saved ?? {}) as { ganttHideDone?: boolean }
    if (legacy.ganttHideDone === true) {
      const nonTerminal = this.settings.statuses.filter((s) => !s.complete).map((s) => s.id)
      for (const entry of Object.values(this.settings.projectFilters)) {
        if (entry.filter.statuses.length === 0) {
          entry.filter.statuses = nonTerminal
        }
      }
      migrated = true
    }

    if (migrated) await this.saveSettings()
  }

  async cleanupStaleProjectFilters(): Promise<void> {
    const filters = this.settings.projectFilters
    const cleaned: typeof filters = {}
    let dirty = false
    for (const [path, entry] of Object.entries(filters)) {
      if (this.app.vault.getAbstractFileByPath(path)) {
        cleaned[path] = entry
      } else {
        dirty = true
      }
    }
    if (dirty) {
      this.settings.projectFilters = cleaned
      await this.saveSettings()
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings)
  }

  showNotice(msg: string, duration = 3000): void {
    new Notice(msg, duration)
  }

  /** Show project picker, then open TaskModal to create a task (optionally pick parent for subtask) */
  private async pickProjectThenCreateTask(mode: null | 'pick-parent'): Promise<void> {
    const projects = await this.store.loadAllProjects(this.settings.projectsFolder)
    if (!projects.length) {
      this.showNotice('No projects yet. Create a project first.')
      return
    }
    openProjectPicker(this, projects, (project) => {
      if (mode === 'pick-parent') {
        const flat = flattenTasks(project.tasks)
        if (!flat.length) {
          this.showNotice('No tasks in this project. Create a task first.')
          return
        }
        openTaskPicker(
          this,
          flat.map((f) => f.task),
          (parentTask) => {
            this.openTaskModalForProject(project, parentTask.id)
          }
        )
      } else {
        this.openTaskModalForProject(project, null)
      }
    })
  }

  private openTaskModalForProject(project: Project, parentId: string | null): void {
    openTaskModal(this, project, {
      parentId,
      onSave: async () => {
        await this.store.saveProject(project)
        await this.router.openProjectByPath(project.filePath)
      }
    })
  }

  private async importNotes(): Promise<void> {
    const activeLeaves = this.app.workspace.getLeavesOfType(PM_PROJECT_VIEW_TYPE)
    let activeProject: Project | null = null

    for (const leaf of activeLeaves) {
      if (!(leaf.view instanceof ProjectView)) continue
      if (leaf.view.project) {
        activeProject = leaf.view.project
        break
      }
    }

    if (activeProject) {
      const project = activeProject
      const onImportComplete = async () => {
        await this.router.openProjectByPath(project.filePath)
      }
      openImportModal(this, activeProject, onImportComplete)
      return
    }

    const projects = await this.store.loadAllProjects(this.settings.projectsFolder)
    if (!projects.length) {
      this.showNotice('No projects yet. Create a project first.')
      return
    }

    openProjectPicker(this, projects, (project) => {
      const onImportComplete = async () => {
        await this.router.openProjectByPath(project.filePath)
      }
      openImportModal(this, project, onImportComplete)
    })
  }
}
