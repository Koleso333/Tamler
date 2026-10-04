const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

async function verify(contents, root, api) {
  const id = 'tamler-ui-check';
  const folder = path.join(root, 'plugins', id);
  if (fs.existsSync(folder)) throw new Error('UI test plugin already exists');
  const evalUI = async source => {
    try { return await contents.executeJavaScript(source); }
    catch (error) { throw new Error(`${source}: ${error.message}`); }
  };
  async function wait(source) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (await evalUI(source)) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`UI assertion timed out: ${source}`);
  }
  fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, 'plugin.json'), JSON.stringify({ id, name: 'Tamler UI Check', version: '1.0.0', css: 'theme.css' }));
  fs.writeFileSync(path.join(folder, 'theme.css'), ':root { --tamler-ui-test: 1; }');
  try {
    assert.ok(await evalUI('document.querySelector("nav[data-perf-region=settings_nav]")'));
    assert.equal(await evalUI('document.querySelectorAll("#customize-pane [data-tamler-manager], [role=tablist] [data-tamler-navigation]").length'), 0);
    assert.equal(await evalUI('document.querySelector("[data-tamler-navigation-item]")?.nextElementSibling?.dataset.testid'), 'customize-skills-settings');
    await api.command({ action: 'refresh' });
    await evalUI('window.Tamler.manager.open()');
    const card = '[...document.querySelectorAll("[data-tamler-manager] [data-cds=Card]")].find(e => e.textContent.includes("Tamler UI Check"))';
    await wait(`${card}?.querySelector('[role=switch]')`);
    await evalUI(`${card}.querySelector('[role=switch]').click()`);
    await wait(`window.Tamler.list().find(p=>p.id==='${id}')?.enabled === false && !${card}.querySelector('[role=switch]').hasAttribute('data-disabled')`);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'data', 'settings.json'))).enabled[id], false);
    await api.reload();
    await wait(`window.Tamler.list().find(p=>p.id==='${id}')?.enabled === false && ${card}?.querySelector('[role=switch]')`);
    await evalUI(`${card}.querySelector('[role=switch]').click()`);
    await wait(`window.Tamler.list().find(p=>p.id==='${id}')?.enabled === true && !${card}.querySelector('[role=switch]').hasAttribute('data-disabled')`);
    const remove = `${card}.querySelector('button[aria-label="Delete Tamler UI Check"]').click()`;
    const confirmation = '([...document.querySelectorAll("[role=alertdialog], [role=dialog]")].find(e=>document.getElementById(e.getAttribute("aria-labelledby"))?.textContent === "Delete Tamler UI Check?"))';
    await evalUI(remove);
    await wait(confirmation);
    await new Promise(resolve => setTimeout(resolve, 250));
    fs.writeFileSync(path.join(root, 'build', 'manager-confirmation.png'), (await contents.capturePage()).toPNG());
    await evalUI(`[...${confirmation}.querySelectorAll('button')].find(e=>e.textContent.trim()==='Cancel').click()`);
    await wait(`!${confirmation}`);
    assert.ok(fs.existsSync(folder));
    await evalUI(remove);
    await wait(confirmation);
    await evalUI(`[...${confirmation}.querySelectorAll('button')].find(e=>e.textContent.trim()==='Delete').click()`);
    await wait(`!window.Tamler.list().some(p=>p.id==='${id}') && !${confirmation}`);
    assert.equal(fs.existsSync(folder), false);
    const trash = path.join(root, 'data', 'removed-plugins');
    assert.ok(fs.readdirSync(trash).some(name => name.endsWith(`-${id}`)));
    await evalUI('document.querySelector("nav[data-perf-region=settings_nav] [data-testid=account-settings] > button").click()');
    await wait('!window.Tamler.managerOpen && (!document.querySelector("[data-tamler-manager]") || document.querySelector("[data-tamler-manager]").style.display === "none")');
    await evalUI('document.querySelector("[data-tamler-navigation]").click()');
    await wait('window.Tamler.managerOpen && document.querySelector("[data-tamler-manager]")?.style.display === "flex"');
    for (let round = 0; round < 3; round++) {
      for (const section of ['customize-skills-settings', 'customize-connectors-settings', 'customize-plugins-settings', 'account-settings']) {
        await evalUI(`document.querySelector('nav[data-perf-region=settings_nav] [data-testid="${section}"] > button').click()`);
        await wait('!window.Tamler.managerOpen && !document.querySelector("[data-tamler-settings-open]")');
        await new Promise(resolve => setTimeout(resolve, round === 0 ? 150 : 10));
        await evalUI('document.querySelector("[data-tamler-navigation]").click()');
        await wait('window.Tamler.managerOpen && document.querySelector("[data-tamler-manager]")?.style.display === "flex"');
        await wait('document.querySelector("[data-tamler-manager]").getBoundingClientRect().height > 0 && getComputedStyle(document.querySelector("[data-tamler-manager]").closest("[role=dialog]")).opacity === "1"');
        await new Promise(resolve => setTimeout(resolve, 60));
        assert.equal(await evalUI('[...document.querySelector("[data-perf-region=settings_panel]").querySelectorAll("h1,h2,h3,input,button,[data-cds=Card]")].filter(e=>!e.closest("[data-tamler-manager],[data-tamler-close]") && e.getBoundingClientRect().width>0 && e.getBoundingClientRect().height>0).length'), 0, `Native content leaked from ${section}`);
      }
    }
    await evalUI('document.querySelector("[data-tamler-close]").click()');
    await wait('!document.querySelector("[role=dialog][data-open] nav[data-perf-region=settings_nav]") && !window.Tamler.managerOpen');
    api.openSettings();
    await wait('document.querySelector("[role=dialog][data-open] nav[data-perf-region=settings_nav] [data-tamler-navigation]")');
    await evalUI('document.querySelector("nav[data-perf-region=settings_nav] [data-tamler-navigation]").click()');
    await wait('window.Tamler.managerOpen && document.querySelector("[data-tamler-manager]")?.style.display === "flex"');
    await wait('document.querySelector("[data-tamler-manager]").getBoundingClientRect().height > 0 && getComputedStyle(document.querySelector("[data-tamler-manager]").closest("[role=dialog]")).opacity === "1"');
    return { sidebarPlacement: true, toggle: true, persistence: true, confirmation: true, cancellation: true, removal: true, navigation: true, rapidSwitching: true, reopen: true };
  } finally {
    if (fs.existsSync(folder)) await api.command({ action: 'remove', id });
    const trash = path.join(root, 'data', 'removed-plugins');
    if (fs.existsSync(trash)) {
      for (const name of fs.readdirSync(trash)) {
        if (!name.endsWith(`-${id}`)) continue;
        const target = path.resolve(trash, name);
        if (path.dirname(target) !== path.resolve(trash)) throw new Error('Invalid test cleanup path');
        fs.rmSync(target, { recursive: true });
      }
    }
  }
}

module.exports = { verify };
