/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import { spawn, ChildProcess } from 'child_process';
import { totalmem } from 'os';
import { exists } from 'fs';

export interface ProcessItem {
	name: string;
	cmd: string;
	pid: number;
	ppid: number;
	load: string;
	mem: string;

	children?: ProcessItem[];
}

export function listProcesses(rootPid: number, withLoad: boolean): Promise<ProcessItem> {

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
			const WINDOWS_WATCHER_HINT = /\\watcher\\win32\\CodeHelper\.exe/;
			const WINDOWS_CRASH_REPORTER = /--crashes-directory/;
			const WINDOWS_PTY = /\\pipe\\winpty-control/;
			const WINDOWS_CONSOLE_HOST = /conhost\.exe/;
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

			// find windows crash reporter
			if (WINDOWS_CRASH_REPORTER.exec(cmd)) {
				return 'electron-crash-reporter';
			}

			// find windows pty process
			if (WINDOWS_PTY.exec(cmd)) {
				return 'winpty-process';
			}

			//find windows console host process
			if (WINDOWS_CONSOLE_HOST.exec(cmd)) {
				return 'console-window-host (Windows internal process)';
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

		// returns a function that aggregates chunks of data until one or more complete lines are received and passes them to a callback.
		function lines(callback: (a: string) => void) {
			let unfinished = '';	// unfinished last line of chunk
			return (data: string | Buffer) => {
				const lines = data.toString().split(/\r?\n/);
				const finishedLines = lines.slice(0, lines.length - 1);
				finishedLines[0] = unfinished + finishedLines[0]; // complete previous unfinished line
				unfinished = lines[lines.length - 1]; // remember unfinished last line of this chunk for next round
				for (const s of finishedLines) {
					callback(s);
				}
			}
		}

		let proc: ChildProcess;

		if (process.platform === 'win32') {

			const CMD_PAT1 = /^(.+)\s+([0-9]+)\s+([0-9]+)\s+([0-9]+)$/;
			const CMD_PAT2 = /^([0-9]+)\s+([0-9]+)$/;

			if (withLoad) {
				const CMD = 'wmic process get CommandLine,ParentProcessId,ProcessId,WorkingSetSize && wmic path win32_perfformatteddata_perfproc_process where (PercentProcessorTime ^> 0) get IDProcess,PercentProcessorTime';
				proc = spawn('cmd', [ '/c',  CMD ]);

			} else {
				proc = spawn('wmic', [ 'process', 'get', 'CommandLine,ParentProcessId,ProcessId,WorkingSetSize' ]);
			}

			proc.stdout.setEncoding('utf8');
			proc.stdout.on('data', lines(line => {
				line = line.trim();
				let matches = CMD_PAT1.exec(line);
				if (matches && matches.length === 5) {
					const mem = parseInt(matches[4])/1024/1024;
					addToTree(parseInt(matches[3]), parseInt(matches[2]), matches[1].trim(), undefined, mem.toFixed(2)+'MB');
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
			}));
			
		} else {	// OS X & Linux

			const CMD_PAT = /^\s*([0-9]+)\s+([0-9]+)\s+([0-9]+\.[0-9]+)\s+([0-9]+\.[0-9]+)\s+(.+)$/;

			const TOTAL_MB = totalmem() / 1024 / 1024;

			proc = spawn('/bin/ps', [ '-ax', '-o', 'pid=,ppid=,pcpu=,pmem=,command=' ]);

			proc.stdout.setEncoding('utf8');
			proc.stdout.on('data', lines(line => {
				let matches = CMD_PAT.exec(line.trim());
				if (matches && matches.length === 6) {
					const mb = TOTAL_MB / 100 * parseFloat(matches[4]);
					const pid = parseInt(matches[1]);
					//if (pid !== p.pid) {
						addToTree(pid, parseInt(matches[2]), matches[5], matches[3]+'%', mb.toFixed(2)+'MB');
					//}
				}
			}));
		}

		proc.on('error', (err) => {
			reject(err.message);
		});

		proc.stderr.setEncoding('utf8');
		proc.stderr.on('data', data => {
			reject(data.toString());
		});

		proc.on('close', (n) => {
			resolve(rootItem);
		});

		proc.on('exit', (code, signal) => {
			if (code === 0) {
				//resolve(rootItem);
			} else if (code > 0) {
				reject(`process terminated with exit code: ${code}`);
			}
			if (signal) {
				reject(`process terminated with signal: ${signal}`);
			}
		});

	});
}
