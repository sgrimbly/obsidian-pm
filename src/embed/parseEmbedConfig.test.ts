import { describe, expect, it } from 'vitest'
import { parseEmbedConfig } from './parseEmbedConfig'

describe('parseEmbedConfig', () => {
  it('returns an error when file is missing', () => {
    const { config, error } = parseEmbedConfig('')
    expect(config).toBe(null)
    expect(error).toMatch(/Missing required `file:`/)
  })

  it('returns an error when file is empty string', () => {
    const { config, error } = parseEmbedConfig('file: ""')
    expect(config).toBe(null)
    expect(error).toMatch(/Missing required `file:`/)
  })

  it('parses minimum-valid body with just file', () => {
    const { config, error } = parseEmbedConfig('file: Projects/PhD Roadmap.md')
    expect(error).toBe(null)
    expect(config).toEqual({
      file: 'Projects/PhD Roadmap.md',
      height: 480,
      granularity: null,
      view: null
    })
  })

  it('trims whitespace around file path', () => {
    const { config } = parseEmbedConfig('file: "  Projects/PhD Roadmap.md  "')
    expect(config?.file).toBe('Projects/PhD Roadmap.md')
  })

  it('accepts a custom height as an integer', () => {
    const { config } = parseEmbedConfig('file: x.md\nheight: 720')
    expect(config?.height).toBe(720)
  })

  it('floors fractional heights', () => {
    const { config } = parseEmbedConfig('file: x.md\nheight: 500.7')
    expect(config?.height).toBe(500)
  })

  it('rejects heights below 100', () => {
    const { config, error } = parseEmbedConfig('file: x.md\nheight: 50')
    expect(config).toBe(null)
    expect(error).toMatch(/height/)
  })

  it('rejects non-numeric heights', () => {
    const { config, error } = parseEmbedConfig('file: x.md\nheight: tall')
    expect(config).toBe(null)
    expect(error).toMatch(/height/)
  })

  it('parses granularity when valid', () => {
    const { config } = parseEmbedConfig('file: x.md\ngranularity: month')
    expect(config?.granularity).toBe('month')
  })

  it('rejects invalid granularity', () => {
    const { config, error } = parseEmbedConfig('file: x.md\ngranularity: decade')
    expect(config).toBe(null)
    expect(error).toMatch(/granularity/)
  })

  it('parses view when valid', () => {
    const { config } = parseEmbedConfig('file: x.md\nview: kanban')
    expect(config?.view).toBe('kanban')
  })

  it('rejects invalid view', () => {
    const { config, error } = parseEmbedConfig('file: x.md\nview: timeline')
    expect(config).toBe(null)
    expect(error).toMatch(/view/)
  })

  it('rejects array bodies', () => {
    const { config, error } = parseEmbedConfig('- file: x.md')
    expect(config).toBe(null)
    expect(error).toMatch(/mapping/)
  })

  it('reports YAML parse errors', () => {
    // Unbalanced bracket forces yaml lib to throw
    const { config, error } = parseEmbedConfig('file: [unclosed')
    expect(config).toBe(null)
    expect(error).toMatch(/Invalid YAML/)
  })
})
