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
import { setInterval } from 'timers';


export const localize = nls.config(process.env.VSCODE_NLS_CONFIG)();

export function activate(context: vscode.ExtensionContext) {

	vscode.window.registerTreeDataProvider('extension.vscode-processes.processViewer', new ProcessProvider(context));

	context.subscriptions.push(vscode.commands.registerCommand('extension.vscode-processes.startDebug', (item: ProcessTreeItem) => {
		const config = {
			type: 'node',
			request: 'attach',
			name: 'attach to process',
			processId: String(item._process.pid),
			protocol: 'inspector'
		};
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

function getName(process: ProcessItem): string {
	return process['deleted'] ? process.name : `${process.name} (${process.load}, ${process.mem})`;
}

function getState(process: ProcessItem): vscode.TreeItemCollapsibleState {
	return process.children && process.children.length > 0 ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None;
}

class ProcessTreeItem extends TreeItem {
	_process: ProcessItem;

	constructor(process: ProcessItem) {
		super(getName(process), getState(process));
		this._process = process;
		if (process.name.startsWith('node ')) {
			this.contextValue = 'node';
		}
	}
	getChildren(): ProcessTreeItem[] {
		if (this._process.children) {
			return this._process.children.map(child => new ProcessTreeItem(child));
		}
		return [];
	}
}

export class ProcessProvider implements TreeDataProvider<ProcessTreeItem> {

	private static KEEP_TERMINATED = false;

	private _root: ProcessTreeItem;

	private _onDidChangeTreeData: EventEmitter<ProcessTreeItem> = new EventEmitter<ProcessTreeItem>();
	readonly onDidChangeTreeData: Event<ProcessTreeItem> = this._onDidChangeTreeData.event;

	constructor(context: vscode.ExtensionContext) {

		const pid = parseInt(process.env['VSCODE_PID']);

		this._root = new ProcessTreeItem({ name: 'root', pid: 0, ppid: 0, cmd: 'root', load: 0.0, mem: 0.0});

		setInterval(_ => {
			listProcesses(pid).then(process => {
				const changed = this.merge(this._root._process, process);
				this._onDidChangeTreeData.fire(undefined);
			});
		}, 2000);
	}

	private merge(old: ProcessItem, process: ProcessItem) {

		old.load = process.load;

		old.children = old.children || [];
		process.children = process.children || [];

		const result: ProcessItem[] = [];
		for (const child of process.children) {
			const found = old.children.find(c => child.pid === c.pid);
			if (found) {
				this.merge(found, child);
				result.push(found);
			} else {
				result.push(child);
			}
		}

		for (const child of old.children) {
			const found = process.children.find(c => child.pid === c.pid);
			if (!found && ProcessProvider.KEEP_TERMINATED) {
				child['deleted'] = true;
				result.push(child);
			}
		}

		old.children = result.sort((a, b) => a.pid - b.pid);
	}

	getTreeItem(element: ProcessTreeItem): ProcessTreeItem | Thenable<ProcessTreeItem> {
		return element;
	}

	getChildren(element?: ProcessTreeItem): vscode.ProviderResult<ProcessTreeItem[]> {
		return (element || this._root).getChildren();
	}
}