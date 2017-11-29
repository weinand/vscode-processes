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

const DEBUG_FLAGS_PATTERN = /\s--(inspect|debug)(-brk)?(=([0-9]+))?/;

export function activate(context: vscode.ExtensionContext) {

	vscode.window.registerTreeDataProvider('extension.vscode-processes.processViewer', new ProcessProvider(context));

	context.subscriptions.push(vscode.commands.registerCommand('extension.vscode-processes.startDebug', (item: ProcessTreeItem) => {

		const config: vscode.DebugConfiguration = {
			type: 'node',
			request: 'attach',
			name: 'attach to process'
		};

		const matches = DEBUG_FLAGS_PATTERN.exec(item._process.cmd);
		if (matches && matches.length >= 2) {
			if (matches.length === 5 && matches[4]) {
				config.port = parseInt(matches[4]);
			}
			config.protocol= matches[1] === 'debug' ? 'legacy' : 'inspector';
		} else {	// no port -> try to attach via SIGUSR and pid
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

		const matches = DEBUG_FLAGS_PATTERN.exec(process.cmd);
		if ((matches && matches.length >= 2) || process.name.startsWith('node ')) {
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
		}, 1000);
	}

	private merge(old: ProcessItem, process: ProcessItem) {

		old.cmd = process.cmd;
		old.load = process.load;
		old.mem = process.mem;

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

		if (ProcessProvider.KEEP_TERMINATED) {
			for (const child of old.children) {
				const found = process.children.find(c => child.pid === c.pid);
				if (!found) {
					child['deleted'] = true;
					result.push(child);
				}
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