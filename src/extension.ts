'use strict'

import { existsSync, readFileSync } from 'fs'
import { dirname, join } from 'path'
import { commands, ExtensionContext, Position, Range, Selection, TextEditor, ViewColumn, window, workspace } from 'vscode'
import { NullableMappedPosition, SourceMapConsumer } from 'source-map'

const SOURCEMAPPING_URL_MARKER = '# sourceMappingURL='
const DATA_URI_MARKER = 'data:application/json;base64,'


function assertValue<T>(v: T | undefined | null, msg = 'Expected a value but did not find any') {
    if (v) return v
    throw new Error(msg)
}

let sourceEditor: TextEditor | null = null

const decoration = window.createTextEditorDecorationType({
    border: '2px solid yellow',
    textDecoration: 'underline',
    outlineColor: 'yellow'
})

async function updateSourceEditor(sourceCode: string, mapping: NullableMappedPosition) {
    if (sourceEditor === null) {
        const doc = await workspace.openTextDocument({content: sourceCode, language: 'xml'})
        sourceEditor = await window.showTextDocument(doc, ViewColumn.Beside)
    } else {
        const currentText = sourceEditor.document.getText()
        if (currentText !== sourceCode) {
            const end = sourceEditor.document.positionAt(currentText.length)
            const range = new Range(new Position(0, 0), end)
            await sourceEditor.edit(b => b.replace(range, sourceCode))
        }
    }

    const start = new Position(assertValue(mapping.line) - 1, assertValue(mapping.column))
    const cursor = new Range(start, new Position(assertValue(mapping.line) - 1, assertValue(mapping.column) + 1))
    sourceEditor.setDecorations(decoration, [cursor])
    sourceEditor.selections = [ new Selection(start, start)]
}

export function activate(context: ExtensionContext) {
    commands.registerCommand('philschatz.showSourcemap', async () => {
        const activeEditor = window.activeTextEditor
        if (activeEditor) {
            const { fsPath } = activeEditor.document.uri
            const { lineCount } = activeEditor.document
            const range = new Range(
                new Position(lineCount - 1, 0),
                new Position(lineCount - 1, Infinity)
            )
            const lastLine = activeEditor.document.getText(range)
            const i = lastLine.indexOf(SOURCEMAPPING_URL_MARKER)
            if (i >= 0) {
                const rest = lastLine.substring(i + SOURCEMAPPING_URL_MARKER.length)
                const space = rest.indexOf(' ')
                let url = 'COULD_NOT_FIND_URL'
                if (space >= 0) {
                    url = rest.substring(0, space)
                } else {
                    url = rest.replace(/-->$/, '').replace(/\*\/$/, '') // Remove comment markers from the end
                }
                url = url.trim()
                
                let sourcemapStr = '{ "_bug": "Could not find a valid sourcemap" }'
                if (url.startsWith(DATA_URI_MARKER)) {
                    // The sourcemap is encoded in the sourceMappingURL. Decode it
                    const buff = Buffer.from(url.substring(DATA_URI_MARKER.length), 'base64');  
                    sourcemapStr = buff.toString('utf-8')
                } else if (/^https?:\/\//.test(url)) {
                    throw new Error('BUG: Remote URLs in the sourceMappingURL are not supported yet')
                } else {
                    sourcemapStr = readFileSync(join(dirname(fsPath), url), 'utf-8')
                }
                
                await SourceMapConsumer.with(JSON.parse(sourcemapStr), null, async (c) => {

                    const cursor = activeEditor.selection.start
                    const mapping = c.originalPositionFor({
                        line: cursor.line + 1, // source-map is 1-based
                        column: cursor.character
                    })
                    const mappingSource = mapping.source
                    if (mappingSource) {
                        let sourceFile = 'couldnotconvertsourcefilestrtofilepath'
                        if (/^file:\//.test(mappingSource)) {
                            sourceFile = mappingSource.replace(/^file:/, '')
                        } else if (mappingSource.startsWith('/')) {
                            sourceFile = mappingSource
                        } else { // assume it is a relative file
                            sourceFile = join(dirname(fsPath), mappingSource)
                        }
                        let sourceText = c.sourceContentFor(mappingSource)
                        if (sourceText === null && existsSync(sourceFile)) {
                            sourceText = readFileSync(sourceFile, 'utf-8')
                        }
                        updateSourceEditor(sourceText || `(no source available for '${mappingSource}')`, mapping)
                    }
                })
            }
        }
    })
}