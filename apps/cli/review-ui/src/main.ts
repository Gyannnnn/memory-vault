import { api, type Decision, type Item, type Summary } from './api';
import { icon, type IconName } from './icons';

type Filter = 'all' | 'undecided' | 'approved' | 'skipped';

const CHUNK = 120;
const LIKELY_JUNK = 0.6;
const labelNames: Record<string, string> = {
  meme: 'Meme',
  greeting: 'Greeting',
  quote: 'Quote',
  forward: 'Forward',
  festival: 'Festival wishes',
  screenshot: 'Screenshot',
  sticker: 'Sticker',
};

const state = {
  summary: null as Summary | null,
  group: '',
  items: [] as Item[],
  filter: 'all' as Filter,
  selected: new Set<string>(),
  anchor: -1,
  focus: 0,
  rendered: 0,
  lightbox: -1,
};

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attributes: Record<string, string> = {},
  ...children: (Node | string | null | undefined)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (name === 'class') node.className = value;
    else node.setAttribute(name, value);
  }
  for (const child of children) if (child !== null && child !== undefined) node.append(child);
  return node;
}

function formatBytes(bytes: number | null): string {
  if (bytes === null) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

const number = new Intl.NumberFormat('en');
const date = new Intl.DateTimeFormat('en', { day: 'numeric', month: 'short', year: 'numeric' });
const decisionWord = (decision: Decision) =>
  decision === 'approved' ? 'keep' : decision === 'skipped' ? 'skip' : 'undecided';

function button(
  label: string,
  options: { icon?: IconName; className?: string; shortcut?: string; iconOnly?: boolean } = {},
): HTMLButtonElement {
  const node = el('button', { type: 'button', class: options.className ?? 'button' });
  if (options.icon) node.append(icon(options.icon));
  if (options.iconOnly) node.setAttribute('aria-label', label);
  else node.append(el('span', {}, label));
  if (options.shortcut) {
    node.append(el('kbd', { 'aria-hidden': 'true' }, options.shortcut));
    node.setAttribute('aria-keyshortcuts', options.shortcut);
  }
  return node;
}

// ─── Layout ─────────────────────────────────────────────────────────────────

const app = document.getElementById('app')!;
const live = el('div', { class: 'visually-hidden', 'aria-live': 'polite' });
const progressText = el('span', { class: 'progress-text' });
const progressBar = el('div', { class: 'progress-bar', role: 'progressbar', 'aria-label': 'Files decided' });
const progressFill = el('div', { class: 'progress-fill' });
progressBar.append(progressFill);
const themeButton = button('Theme', { icon: 'monitor', className: 'icon-button', iconOnly: true });
const helpButton = button('Keyboard shortcuts', {
  icon: 'keyboard',
  className: 'icon-button',
  iconOnly: true,
});

const topbar = el(
  'header',
  { class: 'topbar' },
  el(
    'div',
    { class: 'brand' },
    el('span', { class: 'brand-mark', 'aria-hidden': 'true' }),
    el('span', { class: 'brand-name' }, 'Memory Vault'),
    el('span', { class: 'brand-divider', 'aria-hidden': 'true' }, '/'),
    el('span', { class: 'brand-page' }, 'Junk review'),
  ),
  el('div', { class: 'progress' }, progressText, progressBar),
  el('div', { class: 'topbar-actions' }, themeButton, helpButton),
);

const groupList = el('ul', { class: 'group-list', role: 'list' });
const sidebar = el(
  'nav',
  { class: 'sidebar', 'aria-label': 'Groups' },
  el('p', { class: 'sidebar-title' }, 'Groups'),
  groupList,
);

const groupTitle = el('h1', { class: 'group-title', tabindex: '-1' });
const groupHint = el('p', { class: 'group-hint' });
const groupMeta = el('p', { class: 'group-meta' });
const filterBar = el('div', { class: 'segmented', role: 'radiogroup', 'aria-label': 'Show' });
const keepAll = button('Keep all shown', { icon: 'check', className: 'button button-keep-outline' });
const skipAll = button('Skip all shown', { icon: 'x', className: 'button button-skip-outline' });
const grid = el('ul', {
  id: 'grid',
  class: 'grid',
  role: 'listbox',
  'aria-multiselectable': 'true',
  'aria-label': 'Files',
});
const empty = el('div', { class: 'empty', hidden: '' });
const sentinel = el('div', { class: 'sentinel', 'aria-hidden': 'true' });

const main = el(
  'main',
  { class: 'content' },
  el('section', { class: 'group-header' }, groupTitle, groupHint, groupMeta),
  el('div', { class: 'toolbar' }, filterBar, el('div', { class: 'toolbar-actions' }, keepAll, skipAll)),
  grid,
  empty,
  sentinel,
);

const selectionCount = el('span', { class: 'selection-count' });
const selectionKeep = button('Keep', { icon: 'check', className: 'button button-keep', shortcut: 'K' });
const selectionSkip = button('Skip', { icon: 'x', className: 'button button-skip', shortcut: 'S' });
const selectionUndo = button('Undecide', { icon: 'undo', className: 'button button-quiet', shortcut: 'U' });
const selectionClear = button('Clear selection', { className: 'button button-quiet', shortcut: 'Esc' });
const selectionBar = el(
  'div',
  { class: 'selection-bar', role: 'region', 'aria-label': 'Selection' },
  selectionCount,
  el('div', { class: 'selection-actions' }, selectionKeep, selectionSkip, selectionUndo, selectionClear),
);

const toast = el('div', { class: 'toast', role: 'status' });

const lightboxMedia = el('div', { class: 'lightbox-media' });
const lightboxName = el('h2', { class: 'lightbox-name' });
const lightboxMeta = el('dl', { class: 'lightbox-meta' });
const lightboxKeep = button('Keep', { icon: 'check', className: 'button button-keep', shortcut: 'K' });
const lightboxSkip = button('Skip', { icon: 'x', className: 'button button-skip', shortcut: 'S' });
const lightboxUndo = button('Undecide', { icon: 'undo', className: 'button button-quiet', shortcut: 'U' });
const lightboxPrev = button('Previous file', {
  icon: 'chevronLeft',
  className: 'icon-button lightbox-nav',
  iconOnly: true,
});
const lightboxNext = button('Next file', {
  icon: 'chevronRight',
  className: 'icon-button lightbox-nav',
  iconOnly: true,
});
const lightboxClose = button('Close', { icon: 'x', className: 'icon-button', iconOnly: true });
const lightbox = el(
  'dialog',
  { class: 'lightbox', 'aria-label': 'File preview' },
  el('div', { class: 'lightbox-stage' }, lightboxPrev, lightboxMedia, lightboxNext),
  el(
    'aside',
    { class: 'lightbox-panel' },
    el('div', { class: 'lightbox-panel-top' }, lightboxName, lightboxClose),
    lightboxMeta,
    el('div', { class: 'lightbox-actions' }, lightboxKeep, lightboxSkip, lightboxUndo),
  ),
);

const shortcuts: [string, string][] = [
  ['K', 'Keep selected (or focused) files'],
  ['S', 'Skip selected (or focused) files'],
  ['U', 'Undo the decision'],
  ['Space', 'Select or unselect the focused file'],
  ['Shift + click', 'Select a range'],
  ['Ctrl/⌘ + A', 'Select every file shown'],
  ['Enter', 'Open the preview'],
  ['← → ↑ ↓', 'Move between files'],
  ['Esc', 'Clear the selection or close'],
];
const help = el(
  'dialog',
  { class: 'help', 'aria-labelledby': 'help-title' },
  el('h2', { id: 'help-title' }, 'Keyboard shortcuts'),
  el(
    'dl',
    { class: 'help-list' },
    ...shortcuts.flatMap(([keys, action]) => [el('dt', {}, el('kbd', {}, keys)), el('dd', {}, action)]),
  ),
  el(
    'p',
    { class: 'help-note' },
    'Nothing is deleted here. Kept files upload on the next `vault upload`; skipped files stay where they are and are listed in the report.',
  ),
  (() => {
    const close = button('Done', { className: 'button button-primary' });
    close.addEventListener('click', () => help.close());
    return close;
  })(),
);

app.append(topbar, el('div', { class: 'layout' }, sidebar, main), selectionBar, toast, lightbox, help, live);

// ─── Theme ──────────────────────────────────────────────────────────────────

const themes = ['system', 'light', 'dark'] as const;
type Theme = (typeof themes)[number];
function readTheme(): Theme {
  try {
    const stored = localStorage.getItem('vault-review-theme');
    return themes.includes(stored as Theme) ? (stored as Theme) : 'system';
  } catch {
    return 'system';
  }
}
function applyTheme(theme: Theme): void {
  if (theme === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.dataset.theme = theme;
  themeButton.replaceChildren(icon(theme === 'light' ? 'sun' : theme === 'dark' ? 'moon' : 'monitor'));
  themeButton.setAttribute('aria-label', `Theme: ${theme}. Change theme`);
  try {
    localStorage.setItem('vault-review-theme', theme);
  } catch {
    // storage unavailable: the choice lasts for this page only
  }
}
let theme = readTheme();
applyTheme(theme);
themeButton.addEventListener('click', () => {
  theme = themes[(themes.indexOf(theme) + 1) % themes.length]!;
  applyTheme(theme);
});
helpButton.addEventListener('click', () => help.showModal());

// ─── Rendering ──────────────────────────────────────────────────────────────

function visibleItems(): Item[] {
  switch (state.filter) {
    case 'undecided':
      return state.items.filter((item) => item.decision === null);
    case 'approved':
      return state.items.filter((item) => item.decision === 'approved');
    case 'skipped':
      return state.items.filter((item) => item.decision === 'skipped');
    case 'all':
      return state.items;
  }
}

function renderProgress(): void {
  const summary = state.summary;
  if (!summary) return;
  const fraction = summary.total ? summary.decided / summary.total : 1;
  progressText.textContent = `${number.format(summary.decided)} of ${number.format(summary.total)} decided`;
  progressBar.setAttribute('aria-valuenow', String(Math.round(fraction * 100)));
  progressBar.setAttribute('aria-valuemin', '0');
  progressBar.setAttribute('aria-valuemax', '100');
  progressFill.style.transform = `scaleX(${fraction})`;
}

function renderGroups(): void {
  const groups = state.summary?.groups ?? [];
  groupList.replaceChildren(
    ...groups.map((group) => {
      const decided = group.approved + group.skipped;
      const node = el(
        'button',
        {
          type: 'button',
          class: 'group-button',
          'aria-current': group.key === state.group ? 'true' : 'false',
        },
        el('span', { class: 'group-label' }, group.label),
        el('span', { class: 'group-count' }, number.format(group.count)),
      );
      const bar = el('span', { class: 'group-progress', 'aria-hidden': 'true' });
      const keep = el('span', { class: 'group-progress-keep' });
      const skip = el('span', { class: 'group-progress-skip' });
      keep.style.flexGrow = String(group.approved);
      skip.style.flexGrow = String(group.skipped);
      const rest = el('span', { class: 'group-progress-rest' });
      rest.style.flexGrow = String(group.count - decided);
      bar.append(keep, skip, rest);
      node.append(bar);
      node.setAttribute('aria-label', `${group.label}: ${group.count} files, ${decided} decided`);
      node.addEventListener('click', () => void selectGroup(group.key));
      return el('li', {}, node);
    }),
  );
}

function renderFilter(): void {
  const counts = {
    all: state.items.length,
    undecided: state.items.filter((item) => item.decision === null).length,
    approved: state.items.filter((item) => item.decision === 'approved').length,
    skipped: state.items.filter((item) => item.decision === 'skipped').length,
  };
  const labels: Record<Filter, string> = {
    all: 'All',
    undecided: 'Undecided',
    approved: 'Kept',
    skipped: 'Skipped',
  };
  filterBar.replaceChildren(
    ...(Object.keys(labels) as Filter[]).map((filter) => {
      const node = el(
        'button',
        { type: 'button', role: 'radio', 'aria-checked': String(state.filter === filter), class: 'segment' },
        el('span', {}, labels[filter]),
        el('span', { class: 'segment-count' }, number.format(counts[filter])),
      );
      node.addEventListener('click', () => {
        state.filter = filter;
        state.selected.clear();
        renderAll();
      });
      return node;
    }),
  );
}

function renderHeader(): void {
  const group = state.summary?.groups.find((entry) => entry.key === state.group);
  groupTitle.textContent = group?.label ?? 'Nothing to review';
  groupHint.textContent = group?.hint ?? '';
  groupHint.hidden = !group?.hint;
  const parts = group
    ? [`${number.format(group.count)} files`, formatBytes(group.bytes)]
    : ['Every file from these sources uploads directly.'];
  if (group?.keptElsewhere)
    parts.push(`${number.format(group.keptElsewhere)} also in your own folders (stored either way)`);
  groupMeta.textContent = parts.join(' · ');
}

const mediaObserver = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const thumb = entry.target as HTMLElement;
      mediaObserver.unobserve(thumb);
      const video = el('video', { muted: '', playsinline: '', preload: 'metadata', 'aria-hidden': 'true' });
      video.muted = true;
      video.src = `${api.originalUrl(thumb.dataset.id!)}#t=0.5`;
      thumb.prepend(video);
    }
  },
  { rootMargin: '400px' },
);

function placeholder(item: Item): HTMLElement {
  const extension = item.name.includes('.')
    ? item.name.slice(item.name.lastIndexOf('.') + 1).toUpperCase()
    : 'FILE';
  return el(
    'div',
    { class: 'placeholder' },
    icon(item.kind === 'video' ? 'film' : 'file'),
    el('span', { class: 'placeholder-ext' }, item.size === 0 ? 'Empty file' : extension),
  );
}

function tile(item: Item, index: number): HTMLLIElement {
  const thumb = el('div', { class: 'thumb' });
  if (item.preview === 'image') {
    const image = el('img', { alt: '', loading: 'lazy', decoding: 'async', src: api.previewUrl(item.id) });
    image.addEventListener('error', () => image.replaceWith(placeholder(item)), { once: true });
    thumb.append(image);
  } else if (item.preview === 'video') {
    thumb.dataset.id = item.id;
    thumb.append(el('span', { class: 'thumb-play' }, icon('play')));
    mediaObserver.observe(thumb);
  } else {
    thumb.append(placeholder(item));
  }
  thumb.append(el('span', { class: 'check', 'aria-hidden': 'true' }, icon('check')));
  if (item.decision) {
    thumb.append(
      el(
        'span',
        { class: `decision decision-${item.decision}`, 'aria-hidden': 'true' },
        icon(item.decision === 'approved' ? 'check' : 'x'),
      ),
    );
  }
  const chips = el('div', { class: 'chips' });
  if (
    item.junkScore !== null &&
    item.junkScore >= LIKELY_JUNK &&
    item.junkLabel &&
    labelNames[item.junkLabel]
  ) {
    chips.append(
      el(
        'span',
        { class: 'chip chip-junk' },
        `${labelNames[item.junkLabel]} ${Math.round(item.junkScore * 100)}%`,
      ),
    );
  }
  if (item.keptElsewhere)
    chips.append(
      el(
        'span',
        {
          class: 'chip chip-kept',
          title: 'The same file is in one of your own folders, so it is stored either way',
        },
        icon('layers'),
        'Also in your folders',
      ),
    );
  if (chips.childElementCount) thumb.append(chips);

  const meta = [formatBytes(item.size)];
  if (item.modifiedAt) meta.push(date.format(new Date(item.modifiedAt)));
  const node = el(
    'li',
    {
      class: 'tile',
      role: 'option',
      id: `tile-${index}`,
      'data-index': String(index),
      'data-decision': item.decision ?? 'none',
      'aria-selected': String(state.selected.has(item.id)),
      'aria-label': `${item.name}, ${formatBytes(item.size)}, ${decisionWord(item.decision)}`,
      tabindex: index === state.focus ? '0' : '-1',
    },
    thumb,
    el(
      'div',
      { class: 'caption' },
      el('span', { class: 'caption-name', title: item.path }, item.name),
      el('span', { class: 'caption-meta' }, meta.join(' · ')),
    ),
  );
  return node;
}

function renderMore(): void {
  const items = visibleItems();
  const next = items.slice(state.rendered, state.rendered + CHUNK);
  grid.append(...next.map((item, offset) => tile(item, state.rendered + offset)));
  state.rendered += next.length;
}

function renderGrid(): void {
  grid.replaceChildren();
  state.rendered = 0;
  const items = visibleItems();
  state.focus = Math.min(state.focus, Math.max(0, items.length - 1));
  while (state.rendered < Math.min(items.length, Math.max(CHUNK, state.focus + 1))) renderMore();
  empty.hidden = items.length > 0;
  empty.textContent =
    state.items.length === 0 ? 'Nothing left to review here.' : 'No files match this filter.';
  keepAll.disabled = skipAll.disabled = items.length === 0;
}

function renderSelection(): void {
  const count = state.selected.size;
  selectionBar.dataset.open = String(count > 0);
  selectionCount.textContent = `${number.format(count)} selected`;
  for (const node of grid.querySelectorAll<HTMLElement>('.tile')) {
    const item = visibleItems()[Number(node.dataset.index)];
    node.setAttribute('aria-selected', String(item ? state.selected.has(item.id) : false));
  }
}

function renderAll(): void {
  renderProgress();
  renderGroups();
  renderHeader();
  renderFilter();
  renderGrid();
  renderSelection();
}

new IntersectionObserver(
  (entries) => {
    if (entries.some((entry) => entry.isIntersecting) && state.rendered < visibleItems().length) renderMore();
  },
  { rootMargin: '800px' },
).observe(sentinel);

// ─── Decisions ──────────────────────────────────────────────────────────────

let toastTimer = 0;
function showToast(message: string, undo?: () => void): void {
  toast.replaceChildren(el('span', {}, message));
  if (undo) {
    const undoButton = button('Undo', { className: 'button button-quiet toast-undo' });
    undoButton.addEventListener('click', () => {
      undo();
      toast.dataset.open = 'false';
    });
    toast.append(undoButton);
  }
  toast.dataset.open = 'true';
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (toast.dataset.open = 'false'), 6000);
}

async function refreshSummary(): Promise<void> {
  state.summary = await api.summary();
  renderProgress();
  renderGroups();
  renderHeader();
}

async function decide(
  targets: Item[],
  decision: Decision,
  options: { undoable?: boolean } = {},
): Promise<void> {
  if (targets.length === 0) return;
  const previous = new Map(targets.map((item) => [item.id, item.decision]));
  for (const item of targets) item.decision = decision;
  renderFilter();
  for (const node of grid.querySelectorAll<HTMLElement>('.tile')) {
    const item = visibleItems()[Number(node.dataset.index)];
    if (item && previous.has(item.id)) node.replaceWith(tile(item, Number(node.dataset.index)));
  }
  try {
    await api.decide(
      targets.map((item) => item.id),
      decision,
    );
  } catch (error) {
    for (const item of targets) item.decision = previous.get(item.id) ?? null;
    renderAll();
    showToast(`Could not save: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  const verb =
    decision === 'approved' ? 'Kept' : decision === 'skipped' ? 'Skipped' : 'Cleared the decision on';
  const message = `${verb} ${number.format(targets.length)} file${targets.length === 1 ? '' : 's'}`;
  live.textContent = message;
  if (options.undoable !== false) {
    showToast(message, () => {
      const byPrevious = new Map<Decision, Item[]>();
      for (const item of targets) {
        const before = previous.get(item.id) ?? null;
        byPrevious.set(before, [...(byPrevious.get(before) ?? []), item]);
      }
      void Promise.all([...byPrevious].map(([before, items]) => decide(items, before, { undoable: false })));
    });
  }
  void refreshSummary();
}

function targetsForShortcut(): Item[] {
  if (state.selected.size > 0) return state.items.filter((item) => state.selected.has(item.id));
  const focused = visibleItems()[state.focus];
  return focused ? [focused] : [];
}

async function decideFromKeyboard(decision: Decision): Promise<void> {
  const fromSelection = state.selected.size > 0;
  const targets = targetsForShortcut();
  await decide(targets, decision);
  if (fromSelection) {
    state.selected.clear();
    renderSelection();
  } else if (state.filter === 'all') {
    const next = visibleItems().findIndex((item, index) => index > state.focus && item.decision === null);
    moveFocus(next >= 0 ? next : state.focus + 1);
  }
}

// ─── Selection and focus ────────────────────────────────────────────────────

function columns(): number {
  const template = getComputedStyle(grid).gridTemplateColumns;
  return Math.max(1, template.split(' ').filter(Boolean).length);
}

function moveFocus(index: number): void {
  const items = visibleItems();
  if (items.length === 0) return;
  state.focus = Math.max(0, Math.min(items.length - 1, index));
  while (state.rendered <= state.focus) renderMore();
  for (const node of grid.querySelectorAll<HTMLElement>('.tile[tabindex="0"]')) node.tabIndex = -1;
  const node = document.getElementById(`tile-${state.focus}`);
  if (node) {
    node.tabIndex = 0;
    node.focus({ preventScroll: true });
    node.scrollIntoView({ block: 'nearest' });
  }
}

function toggle(index: number, range: boolean): void {
  const items = visibleItems();
  const item = items[index];
  if (!item) return;
  if (range && state.anchor >= 0) {
    const [start, end] = [Math.min(state.anchor, index), Math.max(state.anchor, index)];
    for (const entry of items.slice(start, end + 1)) state.selected.add(entry.id);
  } else if (state.selected.has(item.id)) state.selected.delete(item.id);
  else state.selected.add(item.id);
  state.anchor = index;
  renderSelection();
}

grid.addEventListener('click', (event) => {
  const node = (event.target as HTMLElement).closest<HTMLElement>('.tile');
  if (!node) return;
  const index = Number(node.dataset.index);
  state.focus = index;
  toggle(index, event.shiftKey);
  moveFocus(index);
});
grid.addEventListener('dblclick', (event) => {
  const node = (event.target as HTMLElement).closest<HTMLElement>('.tile');
  if (node) openLightbox(Number(node.dataset.index));
});

keepAll.addEventListener('click', () => void decide(visibleItems(), 'approved'));
skipAll.addEventListener('click', () => void decide(visibleItems(), 'skipped'));
selectionKeep.addEventListener('click', () => void decideFromKeyboard('approved'));
selectionSkip.addEventListener('click', () => void decideFromKeyboard('skipped'));
selectionUndo.addEventListener('click', () => void decideFromKeyboard(null));
selectionClear.addEventListener('click', () => {
  state.selected.clear();
  renderSelection();
});

// ─── Lightbox ───────────────────────────────────────────────────────────────

function renderLightbox(): void {
  const item = visibleItems()[state.lightbox];
  if (!item) {
    lightbox.close();
    return;
  }
  lightboxMedia.replaceChildren(
    item.preview === 'image'
      ? el('img', { src: api.originalUrl(item.id), alt: item.name })
      : item.preview === 'video'
        ? el('video', { src: api.originalUrl(item.id), controls: '', playsinline: '', preload: 'metadata' })
        : placeholder(item),
  );
  lightboxName.textContent = item.name;
  const rows: [string, string][] = [
    ['Status', item.decision === 'approved' ? 'Keep' : item.decision === 'skipped' ? 'Skip' : 'Undecided'],
    ['Size', formatBytes(item.size)],
    ['Modified', item.modifiedAt ? date.format(new Date(item.modifiedAt)) : '—'],
    ['Location', `${item.sourceId} · ${item.path}`],
  ];
  if (item.junkScore !== null && item.junkLabel) {
    rows.push([
      'Looks like',
      `${labelNames[item.junkLabel] ?? 'A personal photo'} (${Math.round(item.junkScore * 100)}% junk-like)`,
    ]);
  }
  if (item.keptElsewhere)
    rows.push(['Note', 'The same file is in one of your own folders, so it is stored either way.']);
  lightboxMeta.replaceChildren(...rows.flatMap(([term, value]) => [el('dt', {}, term), el('dd', {}, value)]));
  lightboxPrev.disabled = state.lightbox <= 0;
  lightboxNext.disabled = state.lightbox >= visibleItems().length - 1;
}

function openLightbox(index: number): void {
  state.lightbox = index;
  renderLightbox();
  if (!lightbox.open) lightbox.showModal();
}

async function decideInLightbox(decision: Decision): Promise<void> {
  const item = visibleItems()[state.lightbox];
  if (!item) return;
  await decide([item], decision);
  if (state.lightbox < visibleItems().length - 1 && state.filter === 'all') state.lightbox += 1;
  renderLightbox();
}

lightboxPrev.addEventListener('click', () => openLightbox(state.lightbox - 1));
lightboxNext.addEventListener('click', () => openLightbox(state.lightbox + 1));
lightboxClose.addEventListener('click', () => lightbox.close());
lightboxKeep.addEventListener('click', () => void decideInLightbox('approved'));
lightboxSkip.addEventListener('click', () => void decideInLightbox('skipped'));
lightboxUndo.addEventListener('click', () => void decideInLightbox(null));
lightbox.addEventListener('close', () => {
  lightboxMedia.replaceChildren();
  moveFocus(state.lightbox);
});

// ─── Keyboard ───────────────────────────────────────────────────────────────

document.addEventListener('keydown', (event) => {
  if (event.target instanceof HTMLInputElement || event.altKey) return;
  const key = event.key.toLowerCase();
  if (lightbox.open) {
    const actions: Record<string, () => void> = {
      arrowleft: () => openLightbox(Math.max(0, state.lightbox - 1)),
      arrowright: () => openLightbox(Math.min(visibleItems().length - 1, state.lightbox + 1)),
      k: () => void decideInLightbox('approved'),
      s: () => void decideInLightbox('skipped'),
      u: () => void decideInLightbox(null),
    };
    const action = actions[key];
    if (action && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      action();
    }
    return;
  }
  if (help.open) return;
  if ((event.ctrlKey || event.metaKey) && key === 'a') {
    event.preventDefault();
    for (const item of visibleItems()) state.selected.add(item.id);
    renderSelection();
    return;
  }
  if (event.ctrlKey || event.metaKey) return;
  const inGrid = grid.contains(document.activeElement);
  const step: Record<string, number> = {
    arrowleft: -1,
    arrowright: 1,
    arrowup: -columns(),
    arrowdown: columns(),
  };
  if (inGrid && key in step) {
    event.preventDefault();
    moveFocus(state.focus + step[key]!);
    if (event.shiftKey) toggle(state.focus, true);
    return;
  }
  if (inGrid && key === ' ') {
    event.preventDefault();
    toggle(state.focus, event.shiftKey);
    return;
  }
  if (inGrid && key === 'enter') {
    event.preventDefault();
    openLightbox(state.focus);
    return;
  }
  if (key === 'k') void decideFromKeyboard('approved');
  else if (key === 's') void decideFromKeyboard('skipped');
  else if (key === 'u') void decideFromKeyboard(null);
  else if (key === '?') help.showModal();
  else if (key === 'escape' && state.selected.size > 0) {
    state.selected.clear();
    renderSelection();
  }
});

// ─── Start ──────────────────────────────────────────────────────────────────

async function selectGroup(key: string): Promise<void> {
  state.group = key;
  state.items = await api.items(key);
  state.filter = 'all';
  state.selected.clear();
  state.anchor = -1;
  state.focus = 0;
  renderAll();
  groupTitle.focus({ preventScroll: true });
  window.scrollTo({ top: 0 });
}

async function start(): Promise<void> {
  state.summary = await api.summary();
  const first = state.summary.groups[0];
  if (first) await selectGroup(first.key);
  else renderAll();
}

start().catch((error: unknown) => {
  app.replaceChildren(
    el(
      'div',
      { class: 'fatal' },
      el('h1', {}, 'The review page could not load'),
      el('p', {}, error instanceof Error ? error.message : String(error)),
    ),
  );
});
