const PLAN_GROUP = '[role="dialog"].epitaxy-root [role="group"]';
const INLINE_CONTEXT = /\.presentation\s*===\s*["']inline["']\s*&&\s*[\w$.]+\.contextOnly/;

function findContext(group) {
  const fiberKey = Object.keys(group).find(key => key.startsWith('__reactFiber$'));
  let plan = false;
  for (let fiber = group[fiberKey]; fiber; fiber = fiber.return) {
    const props = fiber.memoizedProps;
    if (!props) continue;
    if (Array.isArray(props.children) && props.children.some(child => child?.key === 'tamler-context')) return;
    if (props.presence?.kind && Array.isArray(props.rows) && 'errorAction' in props) plan = true;
    if (!plan || !props.sessionRef?.id) continue;
    const component = fiber.elementType || fiber.type;
    const source = typeof fiber.type === 'function' ? fiber.type : component?.type;
    if (typeof source === 'function' && INLINE_CONTEXT.test(Function.prototype.toString.call(source))) {
      const { sessionRef, modelId, onCompact } = props;
      return { component, sessionRef, modelId, onCompact };
    }
  }
}

module.exports.start = ({ document, window, addStyle, mount, render }) => {
  addStyle(`
    [data-tamler-context-return] > summary {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto 7px;
      align-items: center;
      gap: 4px 7px;
      padding: 4px var(--cds-pad-lg, 12px);
      color: var(--cds-text-secondary);
      cursor: pointer;
      list-style: none;
    }
    [data-tamler-context-return] > summary::-webkit-details-marker { display: none; }
    [data-tamler-context-return] > summary::before {
      content: "";
      grid-area: 1 / 3;
      width: 5px;
      height: 5px;
      border-block-start: 1px solid currentColor;
      border-inline-end: 1px solid currentColor;
      rotate: 45deg;
    }
    [data-tamler-context-return]:dir(rtl) > summary::before { rotate: -135deg; }
    [data-tamler-context-return][open] > summary::before { rotate: 135deg; }
    [data-tamler-context-return] > summary > [data-tamler-context-meter] {
      grid-column: 1 / -1;
      height: 4px;
      overflow: hidden;
      border-radius: 999px;
      background: var(--cds-chart-reference-tint, var(--cds-border));
    }
    [data-tamler-context-meter] > span {
      display: block;
      height: 100%;
      border-radius: inherit;
      background: var(--cds-fill-accent);
    }
    [data-tamler-context-return]:not([open]) > [data-tamler-context-breakdown] { display: none; }
    [data-tamler-context-breakdown] :has(> [data-rail-context-summary]) { display: none; }
  `);
  mount(PLAN_GROUP, group => {
    const section = group.parentElement;
    if (!section || section.previousElementSibling?.hasAttribute('data-tamler-context-return')) return;
    const context = findContext(group);
    if (!context) return;
    const host = document.createElement('details');
    host.dataset.tamlerContextReturn = '';
    host.className = 'border-b border-alpha-2 mb-xs pb-xs';
    const summary = document.createElement('summary');
    summary.className = 'text-footnote rounded focus-visible:shadow-focus';
    const label = document.createElement('span');
    label.textContent = 'Context window';
    const amount = document.createElement('span');
    amount.className = 'tabular-nums whitespace-nowrap';
    const meter = document.createElement('span');
    meter.dataset.tamlerContextMeter = '';
    meter.setAttribute('aria-hidden', 'true');
    const fill = document.createElement('span');
    fill.style.width = '0%';
    meter.append(fill);
    summary.append(label, amount, meter);
    const breakdown = document.createElement('div');
    breakdown.dataset.tamlerContextBreakdown = '';
    breakdown.className = 'px-sm';
    host.append(summary, breakdown);
    section.before(host);
    const syncSummary = () => {
      const readout = breakdown.querySelector('[data-rail-context-summary]');
      const progress = breakdown.querySelector('[role="progressbar"]');
      const percent = parseFloat(readout?.dataset.railContextPct ?? progress?.getAttribute('aria-valuenow'));
      const value = readout?.textContent.trim() || progress?.getAttribute('aria-valuetext');
      label.textContent = progress?.getAttribute('aria-label') || 'Context window';
      amount.textContent = value || (Number.isFinite(percent) ? `${percent}%` : '');
      fill.style.width = Number.isFinite(percent) ? `${Math.min(100, Math.max(0, percent))}%` : '0%';
    };
    const observer = new window.MutationObserver(syncSummary);
    observer.observe(breakdown, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['data-rail-context-pct', 'aria-label', 'aria-valuenow', 'aria-valuetext']
    });
    const panel = render(breakdown, ({ React }) => React.createElement(context.component, {
      sessionRef: context.sessionRef,
      modelId: context.modelId,
      onCompact: context.onCompact,
      contextOnly: true,
      presentation: 'inline',
      popoverRing: {}
    }), { context: group });
    return () => {
      observer.disconnect();
      panel.unmount();
      host.remove();
    };
  }, { attributes: false });
};
