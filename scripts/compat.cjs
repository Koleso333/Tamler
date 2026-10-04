// Список требований к Claude.exe для нативного помощника tamler.exe: версия Electron, экспорты V8 Function::Call и импорты DLL из node.exe.
const fs = require('node:fs');
const path = require('node:path');
const { readPe } = require('./pe.cjs');
const build = path.resolve(__dirname, '..', 'build');
const target = JSON.parse(fs.readFileSync(path.join(build, 'target.json'), 'utf8').replace(/^﻿/, ''));
const required = readPe(path.join(build, 'tamler.dll')).imports.filter(entry => entry.dll.toLowerCase() === 'node.exe').map(entry => entry.name);
if (!required.length) throw new Error('Loader has no Node imports');
const lines = [`electron ${target.electron}`, ...target.callExports.map(name => `call ${name}`), ...required.map(name => `need ${name}`)];
fs.writeFileSync(path.join(build, 'compat.txt'), lines.join('\n') + '\n');
console.log(`Wrote build\\compat.txt: ${required.length} required exports`);
