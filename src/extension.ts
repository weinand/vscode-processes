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

		const matches = DEBUG_FLAGS_PATTERN.exec(item._process.cmd);
		if (matches && matches.length >= 2) {
			// attach via port
			if (matches.length === 5 && matches[4]) {
				config.port = parseInt(matches[4]);
			}
			config.protocol= matches[1] === 'debug' ? 'legacy' : 'inspector';
		} else {
			// no port -> try to attach via pid (send SIGUSR1)
			config.processId = String(item._process.pid);
		}
		vscode.debug.startDebugging(undefined, config);
	}));

	context.subscriptions.push(vscode.commands.registerCommand('extension.vscode-processes.kill', (item: ProcessTreeItem) => {
		if (item._process.pid) {
			process.kill(item._process.pid, 'SIGTERM');
		}
	}));

	context.subscriptions.push(vscode.commands.registerCommand('extension.vscode-processes.forceKill', (item: ProcessTreeItem) => {
		if (item._process.pid) {
			process.kill(item._process.pid, 'SIGKILL');
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
	return isNaN(process.load) && isNaN(process.mem) ? process.name : `${process.name} (${process.load}, ${process.mem})`;
}

class ProcessTreeItem extends TreeItem {
	_process: ProcessItem;
	_deleted: boolean;
	_children: ProcessTreeItem[];

	constructor(process: ProcessItem) {
		super(name(process), vscode.TreeItemCollapsibleState.None);

		this._process = process;

		// enable node debug action
		const matches = DEBUG_FLAGS_PATTERN.exec(process.cmd);
		if ((matches && matches.length >= 2) || process.cmd.indexOf('node ') >= 0 ||process.cmd.indexOf('node.exe') >= 0) {
			this.contextValue = 'node';
		}
	}

	getChildren(): ProcessTreeItem[] {
		if (!this._children) {
			this._children = this._process.children ? this._process.children.map(child => new ProcessTreeItem(child)) : [];
		}
		return this._children;
	}

	merge(process: ProcessItem): ProcessTreeItem | undefined {

		this.label = name(process);

		this._process.pid = process.pid;
		this._process.ppid = process.ppid;

		if (!this._children) {
			this._children = this._process.children ? this._process.children.map(child => new ProcessTreeItem(child)) : [];
		}
		process.children = process.children || [];

		const result: ProcessTreeItem[] = [];
		for (const child of process.children) {
			const found = this._children.find(c => child.pid === c._process.pid);
			if (found) {
				found.merge(child);
				result.push(found);
			} else {
				result.push(new ProcessTreeItem(child));
			}
		}

		if (KEEP_TERMINATED) {
			for (const child of this._children) {
				const found = process.children.find(c => child._process.pid === c.pid);
				if (!found) {
					child._deleted = true;
					result.push(child);
				}
			}
		}

		//this._children = result.sort((a, b) => a._process.pid - b._process.pid);
		this._children = result;

		this.collapsibleState = this._children.length > 0 ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None;

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
				this._root = new ProcessTreeItem({ name: 'root', pid: 0, ppid: 0, cmd: 'root', load: 0.0, mem: 0.0});
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