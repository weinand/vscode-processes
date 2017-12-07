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

const DEBUG_FLAGS_PATTERN = /\s--(inspect|debug)(-brk)?(=([0-9]+))?/;

let processViewer: ProcessProvider;

export function activate(context: vscode.ExtensionContext) {

	context.subscriptions.push(vscode.commands.registerCommand('extension.vscode-processes.showProcessView', () => {
		if (!processViewer) {
			processViewer = new ProcessProvider(context);
			vscode.window.registerTreeDataProvider('extension.vscode-processes.processViewer', processViewer);
		}
		vscode.commands.executeCommand('setContext', 'extension.vscode-processes.processViewerContext', true)
	}));

	context.subscriptions.push(vscode.commands.registerCommand('extension.vscode-processes.startDebug', (item: ProcessTreeItem) => {

		const config: vscode.DebugConfiguration = {
			type: 'node',
			request: 'attach',
			name: 'attach'
		};

		const matches = DEBUG_FLAGS_PATTERN.exec(item._cmd);
		if (matches && matches.length >= 2) {
			// attach via port
			if (matches.length === 5 && matches[4]) {
				config.port = parseInt(matches[4]);
			}
			config.protocol= matches[1] === 'debug' ? 'legacy' : 'inspector';
		} else {
			// no port -> try to attach via pid (send SIGUSR1)
			config.processId = String(item._pid);
		}
		vscode.debug.startDebugging(undefined, config);
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

function name(process: ProcessItem) {
	if (process['deleted']) {
		return `[[ ${process.name} ]]`;
	}
	return process.load && process.mem ? process.name : `${process.name} (${process.load}, ${process.mem})`;
}

class ProcessTreeItem extends TreeItem {
	_pid: number;
	_cmd: string;
	_children: ProcessTreeItem[];

	constructor() {
		super('', vscode.TreeItemCollapsibleState.None);
	}

	getChildren(): ProcessTreeItem[] {
		return this._children || [];
	}

	merge(process: ProcessItem): ProcessTreeItem | undefined {

		let changed = false;

		// update item's name
		const oldLabel = this.label;
		if (process === null) {
			// terminated
			if (!this.label.startsWith('[[ ')) {
				this.label = `[[ ${this.label} ]]`;
			}
		} else {
			this._pid = process.pid;
			this._cmd = process.cmd;
			this.label = process.load && process.mem ? `${process.name} (${process.load}, ${process.mem})` : process.name;
		}
		changed = this.label !== oldLabel;

		// enable item's context (for node debug action)
		const oldContextValue = this.contextValue;
		this.contextValue = undefined;
		if (process) {
			const matches = DEBUG_FLAGS_PATTERN.exec(process.cmd);
			if ((matches && matches.length >= 2) || process.cmd.indexOf('node ') >= 0 ||process.cmd.indexOf('node.exe') >= 0) {
				this.contextValue = 'node';
			}
		}
		changed = changed || this.contextValue !== oldContextValue;

		// update children
		const nextChildren: ProcessTreeItem[] = [];
		if (process) {
			process.children = process.children || [];
			for (const child of process.children) {
				let found = this._children ? this._children.find(c => child.pid === c._pid) : undefined;
				if (!found) {
					found = new ProcessTreeItem();
					changed = true;
				}
				if (found.merge(child)) {
					changed = true;
				}
				nextChildren.push(found);
			}

			if (KEEP_TERMINATED && this._children) {
				for (const child of this._children) {
					const found = process.children.find(c => child._pid === c.pid);
					if (!found) {
						child.merge(null);
						nextChildren.push(child);
					}
				}
			}
		}
		this._children = nextChildren;

		this.collapsibleState = this._children.length > 0 ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None;

		//return changed ? this : undefined;
		return undefined;
	}
}

export class ProcessProvider implements TreeDataProvider<ProcessTreeItem> {

	private _root: ProcessTreeItem;

	private _onDidChangeTreeData: EventEmitter<ProcessTreeItem> = new EventEmitter<ProcessTreeItem>();
	readonly onDidChangeTreeData: Event<ProcessTreeItem> = this._onDidChangeTreeData.event;

	constructor(context: vscode.ExtensionContext) {
		// everything is lazy
	}

	getTreeItem(element: ProcessTreeItem): ProcessTreeItem | Thenable<ProcessTreeItem> {
		return element;
	}

	getChildren(element?: ProcessTreeItem): vscode.ProviderResult<ProcessTreeItem[]> {
		if (!element) {
			const pid = parseInt(process.env['VSCODE_PID']);

			if (!this._root) {
				this._root = new ProcessTreeItem();
				this.refresh(pid);
			}
			element = this._root;

			setTimeout(_ => {
				this.refresh(pid);
			}, POLL_INTERVAL);
		}
		return element.getChildren();
	}

	private refresh(pid: number) {
		listProcesses(pid).then(process => {
			const changed = this._root.merge(process);
			this._onDidChangeTreeData.fire(changed);
		});
	}
}