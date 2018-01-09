/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

'use strict';

import * as vscode from 'vscode';
import { spawn, exec } from 'child_process';
import { basename } from 'path';
import * as nls from 'vscode-nls';
import { listProcesses, ProcessItem } from './ps';
import { TreeDataProvider, TreeItem, EventEmitter, Event, ProviderResult } from 'vscode';
import { setInterval, setTimeout } from 'timers';

export const localize = nls.config(process.env.VSCODE_NLS_CONFIG)();

const POLL_INTERVAL = 2000;
const KEEP_TERMINATED = false;

const DEBUG_FLAGS_PATTERN = /\s--(inspect|debug)(-(brk|port))?(=\d+)?/;
const DEBUG_PORT_PATTERN = /\s--(inspect|debug)-port=(\d+)/;

let processViewer: ProcessProvider;

export function activate(context: vscode.ExtensionContext) {

	context.subscriptions.push(vscode.commands.registerCommand('extension.vscode-processes.showProcessView', () => {
		if (!processViewer) {
			processViewer = new ProcessProvider(context);
			vscode.window.registerTreeDataProvider('extension.vscode-processes.processViewer', processViewer);
		}
		vscode.commands.executeCommand('setContext', 'extension.vscode-processes.processViewerContext', true)
	}));

	context.subscriptions.push(vscode.commands.registerCommand('extension.vscode-processes.startDebug', (item: ProcessTreeItem) => attachTo(item)));

	context.subscriptions.push(vscode.commands.registerCommand('extension.vscode-processes.startDebugAll', (item: ProcessTreeItem) => {
		for (let child of item._children) {
			attachTo(child);
		}
	}));

	context.subscriptions.push(vscode.commands.registerCommand('extension.vscode-processes.kill', (item: ProcessTreeItem) => {
		if (item._pid) {
			process.kill(item._pid, 'SIGTERM');
		}
	}));

	context.subscriptions.push(vscode.commands.registerCommand('extension.vscode-processes.forceKill', (item: ProcessTreeItem) => {
		if (item._pid) {
			process.kill(item._pid, 'SIGKILL');
		}
	}));
}

// this method is called when your extension is deactivated
export function deactivate() {
}

function attachTo(item: ProcessTreeItem) {

	const config: vscode.DebugConfiguration = {
		type: 'node',
		request: 'attach',
		name: `process ${item._pid}`
	};

	let matches = DEBUG_FLAGS_PATTERN.exec(item._cmd);
	if (matches && matches.length >= 2) {
		// attach via port
		if (matches.length === 5 && matches[4]) {
			config.port = parseInt(matches[4]);
		}
		config.protocol = matches[1] === 'debug' ? 'legacy' : 'inspector';
	} else {
		// no port -> try to attach via pid (send SIGUSR1)
		config.processId = String(item._pid);
	}

	// a debug-port=n or inspect-port=n overrides the port
	matches = DEBUG_PORT_PATTERN.exec(item._cmd);
	if (matches && matches.length === 3) {
		// override port
		config.port = parseInt(matches[2]);
	}

	vscode.debug.startDebugging(undefined, config);
}

class ProcessTreeItem extends TreeItem {

	_pid: number;
	_cmd: string;
	_children: ProcessTreeItem[];

	constructor(pid: number) {
		super('', vscode.TreeItemCollapsibleState.None);
		this._pid = pid;
	}

	getChildren(): ProcessTreeItem[] {
		return this._children || [];
	}

	/*
	 * Update this item with the information from the given ProcessItem.
	 * Returns the elementId of the subtree that needs to be refreshed or undefined if nothing has changed.
	 */
	merge(process: ProcessItem): ProcessTreeItem {

		// update item's name
		const oldLabel = this.label;
		if (process === null) {
			// terminated
			if (!this.label.startsWith('[[ ')) {
				this.label = `[[ ${this.label} ]]`;
			}
		} else {
			this._cmd = process.cmd;
			this.label = process.load && process.mem ? `${process.name} (${process.load}, ${process.mem})` : process.name;
		}
		let changed = this.label !== oldLabel;

		// enable item's context (for debug actions)
		const oldContextValue = this.contextValue;
		this.contextValue = this.getContextValue();
		changed = changed || this.contextValue !== oldContextValue;

		// update children
		const childChanges: ProcessTreeItem[] = [];
		const nextChildren: ProcessTreeItem[] = [];
		if (process) {
			process.children = process.children || [];
			for (const child of process.children) {
				let found = this._children ? this._children.find(c => child.pid === c._pid) : undefined;
				if (!found) {
					found = new ProcessTreeItem(child.pid);
					changed = true;
				}
				const changedChild = found.merge(child);
				if (changedChild) {
					childChanges.push(changedChild);
				}
				nextChildren.push(found);
			}

			if (this._children) {
				for (const child of this._children) {
					const found = process.children.find(c => child._pid === c.pid);
					if (!found) {
						changed = true;
						if (KEEP_TERMINATED) {
							child.merge(null);
							nextChildren.push(child);
						}
					}
				}
			}
		}
		this._children = nextChildren;

		// update collapsible state
		const oldCollapsibleState = this.collapsibleState;
		// custom explorer bug: https://github.com/Microsoft/vscode/issues/40179
		this.collapsibleState = this._children.length > 0 ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None;
		if (this.collapsibleState !== oldCollapsibleState) {
			changed = true;
		}

		// attribute changes or changes in more than one child
		if (changed || childChanges.length > 1) {
			return this;
		}

		// changes only in one child -> propagate that child for refresh
		if (childChanges.length === 1) {
			return childChanges[0];
		}

		// no changes
		return undefined;
	}

	getContextValue(): string {

		const myselfDebuggable = this.isDebuggable();

		let anyChildDebuggable = false;
		if (this._children) {
			for (let child of this._children) {
				if (child.isDebuggable()) {
					anyChildDebuggable = true;
					break;
				}
			}
		}

		if (myselfDebuggable || anyChildDebuggable) {
			let contextValue = '';
			if (myselfDebuggable) {
				contextValue += 'node';
			}
			if (myselfDebuggable && anyChildDebuggable) {
				contextValue += '-';
			}
			if (anyChildDebuggable) {
				contextValue += 'subs';
			}
			return contextValue;
		}

		return undefined;
	}

	isDebuggable(): boolean {
		const matches = DEBUG_FLAGS_PATTERN.exec(this._cmd);
		if ((matches && matches.length >= 2) || this._cmd.indexOf('node ') >= 0 || this._cmd.indexOf('node.exe') >= 0) {
			return true;
		}
		return false;
	}
}

export class ProcessProvider implements TreeDataProvider<ProcessTreeItem> {

	private _root: ProcessTreeItem;

	private _onDidChangeTreeData: EventEmitter<ProcessTreeItem> = new EventEmitter<ProcessTreeItem>();
	readonly onDidChangeTreeData: Event<ProcessTreeItem> = this._onDidChangeTreeData.event;

	constructor(context: vscode.ExtensionContext) {
		// everything is lazy
	}

	getTreeItem(processTreeItem: ProcessTreeItem): ProcessTreeItem | Thenable<ProcessTreeItem> {
		return processTreeItem;
	}

	getChildren(element?: ProcessTreeItem): vscode.ProviderResult<ProcessTreeItem[]> {

		if (!element) {
			if (!this._root) {
				const pid = parseInt(process.env['VSCODE_PID']);

				setInterval(_ => {
					listProcesses(pid).then(process => {
						let processTreeItem = this._root.merge(process);
						if (processTreeItem) {
							// workaround for https://github.com/Microsoft/vscode/issues/40185
							if (processTreeItem === this._root) {
								processTreeItem = undefined;
							}
							this._onDidChangeTreeData.fire(processTreeItem);
						}
					});
				}, POLL_INTERVAL);

				this._root = new ProcessTreeItem(pid);
				return listProcesses(pid).then(process => {
					this._root.merge(process);
					return this._root.getChildren();
				});
			}
			element = this._root;
		}
		return element.getChildren();
	}
}