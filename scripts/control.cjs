const net = require('node:net');
const [pid, action = 'reload', payload = '{}'] = process.argv.slice(2);
if (!/^\d+$/.test(pid || '') || !['reload', 'dispose', 'upgrade', 'status', 'toggle', 'pause', 'remove', 'refresh', 'show-manager', 'ui-status', 'capture', 'verify-ui', 'sources'].includes(action)) {
  console.error('Usage: node scripts/control.cjs PID [reload|dispose|upgrade|status|toggle|remove|refresh] [JSON]');
  process.exit(1);
}
const socket = net.createConnection(`\\\\.\\pipe\\tamler-${pid}`);
let output = '';
socket.setEncoding('utf8');
socket.setTimeout(action === 'verify-ui' ? 30000 : 10000, () => socket.destroy(new Error('Control request timed out')));
socket.on('connect', () => socket.write(JSON.stringify({ ...JSON.parse(payload), action }) + '\n'));
socket.on('data', chunk => { output += chunk; });
socket.on('end', () => {
  try {
    const result = JSON.parse(output);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok || Array.isArray(result.results) && result.results.some(entry => entry && (entry.error || entry.errors?.length || entry.loadErrors?.length))) process.exitCode = 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
});
socket.on('error', error => { console.error(error.message); process.exitCode = 1; });
