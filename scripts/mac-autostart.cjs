const path = require('node:path');
const { manageAutostart } = require('../runtime/mac-autostart.cjs');

manageAutostart(path.resolve(__dirname, '..'), process.argv[2] || 'enable')
  .then(result => console.log(JSON.stringify(result, null, 2)))
  .catch(error => { console.error(error.message); process.exitCode = 1; });
