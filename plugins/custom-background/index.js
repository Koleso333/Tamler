// Своя картинка на фоне окна под лентой сообщений.
// Фон окна — main.dframe-content (--df-bg-page): он лежит под всем, включая прозрачную полосу заголовка вверху.
// Картинка рисуется его ::before, поверх неё — слой родного цвета нужной плотности.
// Лента своего фона не имеет, поэтому картинка видна сквозь неё. Но затемнения у краёв ленты и подложка
// поля ввода залиты сплошным цветом и закрыли бы картинку: они прячутся, а текст у краёв растворяется маской.
const FIT = { cover: 'cover', stretch: '100% 100%', height: 'auto 100%', width: '100% auto', original: 'auto' };
// Обычный чат в окне Claude помечен data-frame-mode="cowork", как и Cowork.
const MODES = { both: ':is([data-frame-mode="chat"], [data-frame-mode="cowork"], [data-frame-mode="code"])', chat: ':is([data-frame-mode="chat"], [data-frame-mode="cowork"])', code: '[data-frame-mode="code"]' };
const TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif', bmp: 'image/bmp' };

// Code: лента — виртуальная прокрутка, поле ввода лежит вне её. Затемнения: --epitaxy-top-fade-height и scroll-fade-size-[48px].
const CODE = { scroller: '[data-testid="epitaxy-virtual-transcript"]', top: 32, bottom: 48 };
// Полоса под полем ввода в Code: высоту Claude задаёт inline-стилем.
const CODE_BAND = '[class*="sticky bottom-0 bg-[var(--epitaxy-transcript-surface"]';
// Чат: поле ввода прилипает к низу внутри той же прокрутки, поэтому маска ставится на список сообщений,
// а не на прокрутку. Затемнения: h-6 сверху и page-fade-b-soft (h-10) над полем ввода.
const CHAT = { scroller: '[data-testid="chat-column-body"] > [class*="overflow-y-auto"]', list: '[data-testid="transcript-list"]', top: 24, bottom: 40 };
const CHAT_DOCK = '[class*="in-data-cds-dock-masked:bg-page"]';
// Подложка шапки Cowork заходит под шапку на -bottom-6.
const HEADER_FADE = 24;

// Плавность как у родных затемнений: 0 → .15 → .5 → .85 → 1.
const STEPS = [[0, 'transparent'], [.3, 'rgb(0 0 0 / .15)'], [.6, 'rgb(0 0 0 / .5)'], [.87, 'rgb(0 0 0 / .85)'], [1, '#000']];
const TOP = STEPS.map(([share, color]) => `${color} calc(var(--tamler-bg-top, 0px) * ${share})`);
const BOTTOM = STEPS.slice().reverse().map(([share, color]) => `${color} calc(100% - var(--tamler-bg-band, 0px) - var(--tamler-bg-bottom, 0px) * ${share})`);
const MASK = `linear-gradient(to bottom, ${TOP.concat(BOTTOM).join(', ')})`;
const VARS = ['--tamler-bg-top', '--tamler-bg-bottom', '--tamler-bg-band', '--tamler-bg-y', '--tamler-bg-h'];

module.exports.start = ({ window, signal, storage, files, options, mount, addStyle, cleanup, warn }) => {
  const names = () => (Array.isArray(storage.get('images')) ? storage.get('images') : []).map(file => file.name);
  options('image', () => names().map(name => ({ value: name, label: name })));

  // Выбранная картинка всегда одна из загруженных: после удаления выбирается первая оставшаяся.
  const validate = () => {
    const list = names();
    const current = storage.get('image');
    const next = list.includes(current) ? current : (list[0] ?? '');
    if (next !== (current ?? '')) { storage.set('image', next); return false; }
    return true;
  };

  let picture = null; // { name, url }
  let loading = 0;
  const forget = () => { if (picture) window.URL.revokeObjectURL(picture.url); picture = null; };
  cleanup(forget);

  const style = addStyle('');
  const apply = () => {
    const where = MODES[storage.get('where')] || MODES.both;
    if (!picture) { style.textContent = ''; return; }
    const fit = FIT[storage.get('fit')] || FIT.cover;
    const overlay = Math.min(100, Math.max(0, Number(storage.get('overlay')) || 0));
    const frame = `.dframe-root${where}`;
    const panel = `${frame} .epitaxy-chat-panel`;
    const chat = `${frame} [data-testid="chat-column-body"]`;
    const tint = `color-mix(in srgb, var(--df-bg-page, var(--cds-surface-1)) ${overlay}%, transparent)`;
    style.textContent = `
      ${frame} > main.dframe-content::before {
        content: ""; position: absolute; inset: 0; z-index: -1; pointer-events: none;
        background-image: linear-gradient(${tint}, ${tint}), url("${picture.url}");
        background-size: auto, ${fit}; background-position: center; background-repeat: no-repeat;
      }
      ${panel} .scroll-fade-strip-top, ${panel} .scroll-fade-strip-bottom, ${panel} ${CODE_BAND}, ${panel} [data-testid="pending-nav-scrim"] { visibility: hidden !important; }
      ${panel} [class*="group/approval-dock"] { background-color: transparent !important; }
      ${panel} ${CODE.scroller} { -webkit-mask-image: ${MASK}; mask-image: ${MASK}; }
      ${frame} [class*="h-6 bg-surface-1 [mask-image:"], ${frame} [data-testid="transcript-bottom-fade"], ${frame} .df-header-backdrop { visibility: hidden !important; }
      ${chat} ${CHAT_DOCK} { background: transparent !important; }
      /* «Подбородок» под полем ввода залит фоном и обведён тенью того же цвета на 32px вокруг. */
      ${chat} [class*="[--cmp-chin-start:"] { background: transparent !important; box-shadow: none !important; }
      ${chat} ${CHAT_DOCK}::before { visibility: hidden !important; }
      ${chat} ${CHAT.list} {
        -webkit-mask-image: ${MASK}; mask-image: ${MASK};
        -webkit-mask-size: 100% var(--tamler-bg-h, 100%); mask-size: 100% var(--tamler-bg-h, 100%);
        -webkit-mask-position: 0 var(--tamler-bg-y, 0px); mask-position: 0 var(--tamler-bg-y, 0px);
        -webkit-mask-repeat: no-repeat; mask-repeat: no-repeat;
      }
    `;
  };

  async function load() {
    const name = storage.get('image');
    if (picture?.name === name) { apply(); return; }
    const ticket = ++loading;
    if (!name) { forget(); apply(); return; }
    try {
      const data = await files.read('images', name);
      if (signal.aborted || ticket !== loading) return;
      const type = TYPES[name.split('.').pop().toLowerCase()] || 'image/png';
      forget();
      picture = { name, url: window.URL.createObjectURL(new window.Blob([data], { type })) };
    } catch (error) {
      if (ticket !== loading) return;
      warn(`Cannot read ${name}: ${error.message}`);
      forget();
    }
    apply();
  }

  // Следит за прокруткой и пишет размеры маски CSS-переменными в target(): measure() возвращает { name: px }.
  // Растворение у краёв повторяет родные затемнения: сверху растёт с прокруткой, снизу есть, пока ниже есть текст.
  function track(scroller, target, measure) {
    const written = new Set();
    // Значение пишется, только если изменилось: иначе наблюдатель за style ловил бы собственные записи.
    const set = (element, name, pixels) => {
      const value = `${Math.round(pixels)}px`;
      if (element.style.getPropertyValue(name) !== value) element.style.setProperty(name, value);
      written.add(element);
    };
    // Во время ответа изменения идут пачками: пересчёт один раз на пачку.
    let queued = false;
    const update = () => {
      if (queued) return;
      queued = true;
      window.queueMicrotask(() => {
        queued = false;
        if (!scroller.isConnected) return;
        const element = target();
        if (!element) return;
        for (const [name, pixels] of Object.entries(measure(element))) set(element, name, pixels);
      });
    };
    update();
    scroller.addEventListener('scroll', update, { passive: true });
    const resize = new window.ResizeObserver(update);
    resize.observe(scroller);
    const changes = new window.MutationObserver(update);
    changes.observe(scroller, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'] });
    return () => {
      scroller.removeEventListener('scroll', update);
      resize.disconnect();
      changes.disconnect();
      for (const element of written) for (const name of VARS) element.style.removeProperty(name);
    };
  }

  const below = scroller => scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop;

  mount(CODE.scroller, scroller => track(scroller, () => scroller, () => {
    const band = scroller.querySelector(CODE_BAND);
    return {
      '--tamler-bg-top': Math.max(0, Math.min(scroller.scrollTop, CODE.top)),
      '--tamler-bg-bottom': Math.max(0, Math.min(below(scroller), CODE.bottom)),
      '--tamler-bg-band': band ? Math.max(0, parseFloat(band.style.height) || 0) : 0
    };
  }), { attributes: false });

  // В чате маска рисуется в координатах списка, а он прокручивается: её окно сдвигается на видимую часть
  // прокрутки над полем ввода (--tamler-bg-y, --tamler-bg-h).
  // В Cowork над прокруткой висит шапка с подложкой df-header-backdrop (сплошная, внизу растворяется на 24px):
  // окно маски начинается под шапкой, чтобы текст не просвечивал под заголовком.
  mount(CHAT.scroller, scroller => track(scroller, () => scroller.querySelector(CHAT.list), list => {
    const view = scroller.getBoundingClientRect();
    const dock = scroller.querySelector(CHAT_DOCK);
    const header = (scroller.closest('.dframe-pane-host') || scroller.ownerDocument).querySelector('.df-header-backdrop');
    const headerBottom = header ? header.getBoundingClientRect().bottom - HEADER_FADE : 0;
    const top = Math.max(view.top, headerBottom);
    const bottom = dock ? Math.min(view.bottom, dock.getBoundingClientRect().top) : view.bottom;
    return {
      '--tamler-bg-top': Math.max(0, Math.min(scroller.scrollTop, CHAT.top)),
      '--tamler-bg-bottom': Math.max(0, Math.min(below(scroller), CHAT.bottom)),
      '--tamler-bg-y': top - list.getBoundingClientRect().top,
      '--tamler-bg-h': Math.max(0, bottom - top)
    };
  }), { attributes: false });

  if (validate()) load();
  storage.subscribe(() => { if (validate()) load(); });
};
