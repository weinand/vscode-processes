/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import { spawn, exec } from 'child_process';
import { totalmem } from 'os';

export interface ProcessItem {
	name: string;
	cmd: string;
	pid: number;
	ppid: number;
	load: string;
	mem: string;

	children?: ProcessItem[];
}

export function listProcesses(rootPid: number): Promise<ProcessItem> {

	return new Promise((resolve, reject) => {

		let rootItem: ProcessItem;
		const map = new Map<number, ProcessItem>();

		function addToTree(pid: number, ppid: number, cmd: string, load: string, mem: string) {

			const parent = map.get(ppid);
			if (pid === rootPid || parent) {

				const item: ProcessItem = {
					name: findName(cmd),
					cmd,
					pid,
					ppid,
					load,
					mem
				};
				map.set(pid, item);

				if (pid === rootPid) {
					rootItem = item;
				}

				if (parent) {
					if (!parent.children) {
						parent.children = [];
					}
					parent.children.push(item);
				}
			}
		}

		function findName(cmd: string): string {

			const RENDERER_PROCESS_HINT = /--disable-blink-features=Auxclick/;
			const WINDOWS_WATCHER_HINT = /\\watcher\\win32\\CodeHelper.exe/;
			const TYPE = /--type=([a-zA-Z-]+)/;

			// remove leading device specifier

			const cleanUNCPrefix = (value: string): string => {
				if (value.indexOf('\\\\?\\') === 0) {
					return value.substr(4);
				} else if (value.indexOf('\\??\\') === 0) {
					return value.substr(4);
				} else if (value.indexOf('"\\\\?\\') === 0) {
					return '"' + value.substr(5);
				} else if (value.indexOf('"\\??\\') === 0) {
					return '"' + value.substr(5);
				} else {
					return value;
				}
			};

			cmd = cleanUNCPrefix(cmd);

			// find windows file watcher
			if (WINDOWS_WATCHER_HINT.exec(cmd)) {
				return 'watcherService';
			}

			// find "--type=xxxx"
			let matches = TYPE.exec(cmd);
			if (matches && matches.length === 2) {
				if (matches[1] === 'renderer') {
					if (!RENDERER_PROCESS_HINT.exec(cmd)) {
						return 'shared-process';
					}
					return `renderer`;
				}
				return matches[1];
			}

			// find all xxxx.js
			const JS = /[a-zA-Z-]+\.js/g;
			let result = '';
			do {
				matches = JS.exec(cmd);
				if (matches) {
					result += matches + ' ';
				}
			} while (matches);

			if (result) {
				if (cmd.indexOf('node ') < 0 && cmd.indexOf('node.exe') < 0) {
					return `electron_node ${result}`;
				}
			}
			return cmd;
		}

		if (process.platform === 'win32') {

			const CMD = 'wmic process get CommandLine,ParentProcessId,ProcessId,WorkingSetSize && wmic path win32_perfformatteddata_perfproc_process where (PercentProcessorTime ^> 0) get IDProcess,PercentProcessorTime';
			const CMD_PAT1 = /^(.+)\s+([0-9]+)\s+([0-9]+)\s+([0-9]+)$/;
			const CMD_PAT2 = /^([0-9]+)\s+([0-9]+)$/;

			const cmd = exec(CMD, { maxBuffer: 1000 * 1024 }, (err, stdout, stderr) => {

				if (err || stderr) {
					reject(stderr);
				} else {

					const lines = stdout.split('\r\n');
					for (let line of lines) {
						line = line.trim();
						let matches = CMD_PAT1.exec(line);
						if (matches && matches.length === 5) {
							const mem = parseInt(matches[4])/1024/1024;
							addToTree(parseInt(matches[3]), parseInt(matches[2]), matches[1].trim(), '0%', mem.toFixed(2)+'MB');
						} else {
							matches = CMD_PAT2.exec(line);
							if (matches && matches.length === 3) {
								const pid = parseInt(matches[1]);
								const process = map.get(pid);
								if (process) {
									process.load = matches[2] + '%';
								}
							}
						}
					}

					resolve(rootItem);
				}
			});
		} else {	// OS X & Linux

			const CMD = 'ps -ax -o pid=,ppid=,pcpu=,pmem=,command=';
			const CMD_PAT = /^\s*([0-9]+)\s+([0-9]+)\s+([0-9]+\.[0-9]+)\s+([0-9]+\.[0-9]+)\s+(.+)$/;

			const TOTAL_MB = totalmem() / 1024 / 1024;

			const p = exec(CMD, { maxBuffer: 1000 * 1024 }, (err, stdout, stderr) => {

				if (err || stderr) {
					reject(err || stderr.toString());
				} else {

					const lines = stdout.toString().split('\n');
					for (const line of lines) {
						let matches = CMD_PAT.exec(line.trim());
						if (matches && matches.length === 6) {
							const mb = TOTAL_MB / 100 * parseFloat(matches[4]);
							addToTree(parseInt(matches[1]), parseInt(matches[2]), matches[5], matches[3]+'%', mb.toFixed(2)+'MB');
						}
					}

					resolve(rootItem);
				}
			});
		}
	});
}
