/*
 * Notebook Navigator - Plugin for Obsidian
 * Copyright (c) 2025-2026 Johan Sanneblad
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 *
 * The embedded editor adapter is derived from the MIT-licensed
 * "Embeddable CM Markdown Editor" gist by Matthew Meyers and Fevol:
 * https://gist.github.com/Fevol/caa478ce303e69eabede7b12b2323838
 *
 * Copyright 2024 Matthew Meyers, Fevol
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 */

import { Component, Scope, type App, type TFile, type WorkspaceLeaf } from 'obsidian';
import { EditorSelection, type Extension } from '@codemirror/state';
import { EditorView, keymap, placeholder, type ViewUpdate } from '@codemirror/view';
import { Prec } from '@codemirror/state';

type Cleanup = () => void;
type AroundFactory = (original: unknown) => unknown;

type InternalEditorConstructor = new (app: App, container: HTMLElement, owner: Record<string, unknown>) => InternalMarkdownEditor;

interface InternalMarkdownEditor extends Component {
    [key: string]: unknown;
    app: App;
    activeCM?: { hasFocus?: boolean };
    containerEl: HTMLElement;
    editor?: { cm?: EditorView };
    editorEl?: HTMLElement;
    owner?: Record<string, unknown>;
    _loaded?: boolean;
    set?: (value: string) => void;
}

export interface EmbeddableMarkdownEditorHandle extends Component {
    readonly initialValue: string;
    readonly value: string;
    hasFocus(): boolean;
    destroy(): void;
}

export interface EmbeddableMarkdownEditorOptions {
    cursorLocation?: { anchor: number; head: number };
    value?: string;
    cls?: string;
    placeholder?: string;
    file?: TFile | null;
    onEnter?: (editor: EmbeddableMarkdownEditorHandle, mod: boolean, shift: boolean) => boolean;
    onEscape?: (editor: EmbeddableMarkdownEditorHandle) => void;
    onSubmit?: (editor: EmbeddableMarkdownEditorHandle) => void;
    onBlur?: (editor: EmbeddableMarkdownEditorHandle) => void;
    onPaste?: (event: ClipboardEvent, editor: EmbeddableMarkdownEditorHandle) => void;
    onChange?: (update: ViewUpdate, editor: EmbeddableMarkdownEditorHandle) => void;
}

const editorClassByApp = new WeakMap<
    App,
    new (app: App, container: HTMLElement, options: EmbeddableMarkdownEditorOptions) => EmbeddableMarkdownEditorHandle
>();

function applyAround(target: object, factories: Record<string, AroundFactory>): Cleanup {
    const originals = new Map<string, unknown>();

    Object.entries(factories).forEach(([propertyName, factory]) => {
        const current = (target as Record<string, unknown>)[propertyName];
        originals.set(propertyName, current);
        (target as Record<string, unknown>)[propertyName] = factory(current);
    });

    return () => {
        originals.forEach((original, propertyName) => {
            (target as Record<string, unknown>)[propertyName] = original;
        });
    };
}

function resolveEditorConstructor(app: App): InternalEditorConstructor {
    const embedRegistry = (app as App & { embedRegistry?: { embedByExtension?: { md?: unknown } } }).embedRegistry;
    const embedMarkdown = embedRegistry?.embedByExtension?.md;
    if (typeof embedMarkdown !== 'function') {
        throw new Error('Obsidian embedded Markdown editor API is unavailable.');
    }

    const widgetEditorView = embedMarkdown.call(
        embedRegistry?.embedByExtension,
        { app, containerEl: activeDocument.createElement('div') },
        null,
        ''
    ) as {
        editable?: boolean;
        editMode?: unknown;
        showEditor?: () => void;
        unload?: () => void;
    };

    try {
        widgetEditorView.editable = true;
        widgetEditorView.showEditor?.();

        const editMode = widgetEditorView.editMode;
        if (!editMode) {
            throw new Error('Obsidian embedded Markdown editor did not initialize edit mode.');
        }

        const prototype = Object.getPrototypeOf(Object.getPrototypeOf(editMode)) as { constructor?: unknown } | null;
        if (typeof prototype?.constructor !== 'function') {
            throw new Error('Obsidian embedded Markdown editor prototype is unavailable.');
        }

        return prototype.constructor as InternalEditorConstructor;
    } finally {
        widgetEditorView.unload?.();
    }
}

function createEmbeddableMarkdownEditorClass(
    app: App
): new (app: App, container: HTMLElement, options: EmbeddableMarkdownEditorOptions) => EmbeddableMarkdownEditorHandle {
    const cached = editorClassByApp.get(app);
    if (cached) {
        return cached;
    }

    const BaseEditor = resolveEditorConstructor(app);

    class NotebookNavigatorEmbeddableMarkdownEditor extends BaseEditor implements EmbeddableMarkdownEditorHandle {
        public readonly initialValue: string;
        public readonly options: Required<Omit<EmbeddableMarkdownEditorOptions, 'file' | 'cursorLocation' | 'cls'>> &
            Pick<EmbeddableMarkdownEditorOptions, 'file' | 'cursorLocation' | 'cls'>;
        private readonly scope: Scope;
        private cleanupDone = false;

        constructor(app: App, container: HTMLElement, options: EmbeddableMarkdownEditorOptions = {}) {
            const owner = {
                app,
                get file() {
                    return options.file ?? null;
                },
                getMode: () => 'source',
                onMarkdownScroll: () => {}
            };
            super(app, container, owner);

            this.options = {
                value: '',
                placeholder: '',
                onEnter: () => false,
                onEscape: () => {},
                onSubmit: () => {},
                onBlur: () => {},
                onPaste: () => {},
                onChange: () => {},
                ...options
            };
            this.initialValue = this.options.value;
            this.scope = new Scope(app.scope);
            this.scope.register(['Mod'], 'Enter', () => true);

            if (this.owner) {
                this.owner.editMode = this;
                this.owner.editor = this.editor;
            }

            this.set?.(this.options.value);
            this.register(
                applyAround(app.workspace, {
                    setActiveLeaf: (original: unknown) => {
                        return (leaf: WorkspaceLeaf, params?: { focus?: boolean }) => {
                            if (this.activeCM?.hasFocus) {
                                return;
                            }
                            if (typeof original === 'function') {
                                original.call(app.workspace, leaf, params);
                            }
                        };
                    }
                })
            );

            const cmContent = this.editor?.cm?.contentDOM;
            cmContent?.addEventListener('blur', () => {
                app.keymap.popScope(this.scope);
                if (this._loaded) {
                    this.options.onBlur(this);
                }
            });
            cmContent?.addEventListener('focusin', () => {
                app.keymap.pushScope(this.scope);
                app.workspace.activeEditor = this.owner as never;
            });

            if (this.options.cls && this.editorEl) {
                this.editorEl.classList.add(this.options.cls);
            }
            if (this.options.cursorLocation && this.editor?.cm) {
                this.editor.cm.dispatch({
                    selection: EditorSelection.range(this.options.cursorLocation.anchor, this.options.cursorLocation.head)
                });
            }
        }

        get value(): string {
            return this.editor?.cm?.state.doc.toString() ?? '';
        }

        hasFocus(): boolean {
            return Boolean(this.activeCM?.hasFocus || this.editor?.cm?.hasFocus);
        }

        onUpdate(update: ViewUpdate, changed: boolean): void {
            const parentPrototype = Object.getPrototypeOf(NotebookNavigatorEmbeddableMarkdownEditor.prototype) as {
                onUpdate?: (this: InternalMarkdownEditor, update: ViewUpdate, changed: boolean) => void;
            };
            const parentOnUpdate = parentPrototype.onUpdate;
            parentOnUpdate?.call(this, update, changed);
            if (changed) {
                this.options.onChange(update, this);
            }
        }

        buildLocalExtensions(): Extension[] {
            const parentPrototype = Object.getPrototypeOf(NotebookNavigatorEmbeddableMarkdownEditor.prototype) as {
                buildLocalExtensions?: (this: InternalMarkdownEditor) => Extension[];
            };
            const parentBuildLocalExtensions = parentPrototype.buildLocalExtensions;
            const extensions = parentBuildLocalExtensions?.call(this) ?? [];
            if (this.options.placeholder) {
                extensions.push(placeholder(this.options.placeholder));
            }

            extensions.push(
                EditorView.domEventHandlers({
                    paste: event => {
                        this.options.onPaste(event, this);
                    }
                })
            );
            extensions.push(
                Prec.highest(
                    keymap.of([
                        {
                            key: 'Enter',
                            run: () => this.options.onEnter(this, false, false),
                            shift: () => this.options.onEnter(this, false, true)
                        },
                        {
                            key: 'Mod-Enter',
                            run: () => this.options.onEnter(this, true, false),
                            shift: () => this.options.onEnter(this, true, true)
                        },
                        {
                            key: 'Escape',
                            run: () => {
                                this.options.onEscape(this);
                                return true;
                            },
                            preventDefault: true
                        }
                    ])
                )
            );

            return extensions;
        }

        destroy(): void {
            if (!this.cleanupDone && this._loaded) {
                this.unload();
            }
            this.cleanup();
            const parentPrototype = Object.getPrototypeOf(NotebookNavigatorEmbeddableMarkdownEditor.prototype) as {
                destroy?: (this: InternalMarkdownEditor) => void;
            };
            const parentDestroy = parentPrototype.destroy;
            parentDestroy?.call(this);
        }

        onunload(): void {
            this.cleanup();
            super.onunload?.();
        }

        private cleanup(): void {
            if (this.cleanupDone) {
                return;
            }
            this.cleanupDone = true;
            this.app.keymap.popScope(this.scope);
            if ((this.app.workspace.activeEditor as unknown) === this.owner) {
                this.app.workspace.activeEditor = null;
            }
            this.containerEl.empty();
        }
    }

    editorClassByApp.set(app, NotebookNavigatorEmbeddableMarkdownEditor);
    return NotebookNavigatorEmbeddableMarkdownEditor;
}

export class EmbeddableMarkdownEditor extends Component implements EmbeddableMarkdownEditorHandle {
    private readonly impl: EmbeddableMarkdownEditorHandle;

    constructor(app: App, container: HTMLElement, options: EmbeddableMarkdownEditorOptions = {}) {
        super();
        const EditorClass = createEmbeddableMarkdownEditorClass(app);
        this.impl = new EditorClass(app, container, options);
        this.addChild(this.impl);
    }

    get initialValue(): string {
        return this.impl.initialValue;
    }

    get value(): string {
        return this.impl.value;
    }

    hasFocus(): boolean {
        return this.impl.hasFocus();
    }

    destroy(): void {
        this.impl.destroy();
    }
}
