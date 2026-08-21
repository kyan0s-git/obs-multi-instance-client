/**
 * Reader/writer for the flat INI dialect libobs uses for `global.ini`,
 * `basic.ini` and friends.
 *
 * The format is deliberately simple: `[Section]` headers, `key=value` lines,
 * `#` comments. Values are stored verbatim — no quoting, no escaping, no
 * type coercion — which is exactly how libobs treats them.
 */

export type IniSection = Map<string, string>
export type IniDocument = Map<string, IniSection>

export function parseIni(text: string): IniDocument {
  const doc: IniDocument = new Map()
  let current: IniSection = new Map()
  doc.set('', current)

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue

    if (line.startsWith('[') && line.endsWith(']')) {
      const name = line.slice(1, -1)
      current = doc.get(name) ?? new Map()
      doc.set(name, current)
      continue
    }

    const eq = line.indexOf('=')
    if (eq === -1) continue
    current.set(line.slice(0, eq).trim(), line.slice(eq + 1))
  }

  // Drop the implicit pre-header section when nothing landed in it.
  const root = doc.get('')
  if (root && root.size === 0) doc.delete('')
  return doc
}

export function serializeIni(doc: IniDocument): string {
  const parts: string[] = []
  for (const [section, entries] of doc) {
    if (entries.size === 0) continue
    if (section !== '') parts.push(`[${section}]`)
    for (const [key, value] of entries) parts.push(`${key}=${value}`)
    parts.push('')
  }
  return parts.join('\n')
}

export function iniGet(doc: IniDocument, section: string, key: string): string | undefined {
  return doc.get(section)?.get(key)
}

export function iniSet(doc: IniDocument, section: string, key: string, value: string): void {
  let entries = doc.get(section)
  if (!entries) {
    entries = new Map()
    doc.set(section, entries)
  }
  entries.set(key, value)
}

export function iniDelete(doc: IniDocument, section: string, key: string): void {
  doc.get(section)?.delete(key)
}

/** Applies `{section: {key: value}}` onto a document, creating sections as needed. */
export function iniMerge(doc: IniDocument, patch: Record<string, Record<string, string>>): void {
  for (const [section, entries] of Object.entries(patch)) {
    for (const [key, value] of Object.entries(entries)) iniSet(doc, section, key, value)
  }
}
