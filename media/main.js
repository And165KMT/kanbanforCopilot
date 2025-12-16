// @ts-nocheck

const vscode = acquireVsCodeApi();

/** @typedef {{version:1, columns:string[], tasks: any[]}} BoardFile */

/** @type {BoardFile|null} */
let board = null;

/** @type {string|null} */
let editingTaskId = null;

/** @type {string} */
let adoCommentDraft = '';

/** @type {string} */
let searchQuery = '';

/** @type {string} */
let searchDraft = '';

/** @type {boolean} */
let shouldAutofocus = false;

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = String(v);
    else if (k === 'text') node.textContent = String(v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, String(v));
  }
  for (const child of children) {
    node.appendChild(child);
  }
  return node;
}

function render() {
  const root = document.getElementById('app');
  root.textContent = '';

  const search = el('vscode-text-field', {
    class: 'topbar__search',
    placeholder: 'Search (press Enter to apply)'
  });
  if (!searchDraft) searchDraft = searchQuery;
  search.value = searchDraft;

  const clearSearch = el(
    'vscode-button',
    {
      class: 'topbar__searchClear',
      appearance: 'icon',
      title: 'Clear search',
      'aria-label': 'Clear search',
      onclick: () => {
        searchDraft = '';
        searchQuery = '';
        render();
      }
    },
    [el('span', { text: '×' })]
  );

  const syncClearSearchState = () => {
    const has = String(search.value ?? '').trim().length > 0;
    if (has) clearSearch.removeAttribute('disabled');
    else clearSearch.setAttribute('disabled', '');
  };
  syncClearSearchState();

  // To avoid breaking IME composition, do not re-render on each input; apply on Enter.
  search.addEventListener('input', () => {
    searchDraft = String(search.value ?? '');
    syncClearSearchState();
  });
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      searchQuery = String(searchDraft ?? '');
      render();
      return;
    }
    if (e.key === 'Escape') {
      searchDraft = '';
      searchQuery = '';
      render();
    }
  });

  const topbar = el('div', { class: 'topbar' }, [
    el('div', { class: 'topbar__title', text: 'Task board' }),
    el('div', { class: 'topbar__searchWrap' }, [search, clearSearch]),
    el('div', { class: 'topbar__actions' }, [
      button('Columns', () => vscode.postMessage({ type: 'editColumns' })),
      button('Settings', () => vscode.postMessage({ type: 'openEnvSettings' })),
      button('Azureから取り込み', () => vscode.postMessage({ type: 'importAzure' })),
      button('+ New', () => openCreateModal(), 'primary')
    ])
  ]);

  root.appendChild(topbar);

  if (!board) {
    root.appendChild(el('div', { class: 'empty', text: 'Loading…' }));
    return;
  }

  const boardEl = el('div', { class: 'board' });

  const q = searchQuery.trim().toLowerCase();
  const matches = (t) => {
    if (!q) return true;
    const hay = [t.title ?? '', t.goal ?? '', t.notes ?? ''].join('\n').toLowerCase();
    return hay.includes(q);
  };

  for (const col of board.columns) {
    const tasks = board.tasks
      .filter((t) => t.status === col)
      .filter((t) => matches(t))
      .sort((a, b) => a.order - b.order);

    const addBtn = el(
      'vscode-button',
      {
        class: 'column__add',
        appearance: 'icon',
        title: `Add task to "${col}"`,
        'aria-label': `Add task to "${col}"`,
        onclick: (e) => {
          e.preventDefault();
          e.stopPropagation();
          openCreateModal(col);
        }
      },
      [el('span', { text: '+' })]
    );

    const header = el('div', { class: 'column__header' }, [
      el('div', { class: 'column__headerLeft' }, [el('div', { class: 'column__name', text: col })]),
      el('div', { class: 'column__headerRight' }, [
        addBtn,
        el('span', { class: 'badge', text: String(tasks.length) })
      ])
    ]);

    const list = el('div', { class: 'column__list', 'data-status': col });

    list.addEventListener('dragover', (e) => {
      e.preventDefault();
      list.classList.add('is-drop-target');
    });

    list.addEventListener('dragleave', () => {
      list.classList.remove('is-drop-target');
    });

    list.addEventListener('drop', (e) => {
      e.preventDefault();
      list.classList.remove('is-drop-target');
      const id = e.dataTransfer?.getData('text/task-id');
      if (!id) return;

      const target = /** @type {HTMLElement} */ (e.target);
      const cardEl = target.closest('[data-task-id]');
      let index = tasks.length;
      if (cardEl) {
        const beforeId = cardEl.getAttribute('data-task-id');
        const idx = tasks.findIndex((t) => t.id === beforeId);
        index = idx >= 0 ? idx : tasks.length;
      }

      vscode.postMessage({ type: 'moveTask', id, status: col, index });
    });

    for (const t of tasks) {
      list.appendChild(taskCard(t));
    }
    if (tasks.length === 0) {
      list.appendChild(el('div', { class: 'column__empty', text: 'No tasks' }));
    }

    const colEl = el('div', { class: 'column' }, [header, list]);
    boardEl.appendChild(colEl);
  }

  root.appendChild(boardEl);

  if (editingTaskId) {
    const task = board.tasks.find((t) => t.id === editingTaskId);
    if (task) {
      root.appendChild(taskModal(task));
      if (shouldAutofocus) {
        shouldAutofocus = false;
        setTimeout(() => {
          const input = document.querySelector('[data-autofocus="true"]');
          if (input && typeof input.focus === 'function') input.focus();
        }, 0);
      }
    }
  }
}

function button(text, onClick, appearance = 'secondary') {
  return el('vscode-button', { appearance, onclick: onClick, text });
}

function taskCard(task) {
  const node = el('div', {
    class: 'card',
    draggable: 'true',
    tabindex: '0',
    role: 'button',
    'aria-label': `Open task: ${String(task.title ?? '').trim() || 'Untitled'}`,
    'data-task-id': task.id
  });

  node.appendChild(el('div', { class: 'card__title', text: task.title }));

  const meta = el('div', { class: 'card__meta' });
  const p = clampInt(String(task.priority ?? 0), 0, 999);
  meta.appendChild(el('span', { class: `kv kv--priority ${priorityTone(p)}`, text: `P${p}` }));
  if (task.difficulty) meta.appendChild(el('span', { class: 'kv kv--difficulty', text: `D${task.difficulty}` }));
  if (task.branchType) meta.appendChild(el('span', { class: 'kv kv--branch', text: task.branchType }));
  const adoId = extractAdoWorkItemId(task);
  if (adoId) meta.appendChild(el('span', { class: 'kv kv--ado', text: `ADO#${adoId}` }));
  node.appendChild(meta);

  // Delete affordance (avoid interfering with card click -> modal)
  const delBtn = el('vscode-button', {
    class: 'card__action card__action--delete',
    appearance: 'icon',
    'aria-label': 'Delete',
    title: 'Delete',
    onclick: (e) => {
      e.preventDefault();
      e.stopPropagation();
      deleteTask(task.id);
    }
  });
  delBtn.appendChild(el('span', { text: '×' }));

  // Copy affordance (avoid interfering with card click -> modal)
  const copyBtn = el('vscode-button', {
    class: 'card__action card__action--copy',
    appearance: 'icon',
    'aria-label': 'Copy Markdown',
    title: 'Copy Markdown',
    onclick: (e) => {
      e.preventDefault();
      e.stopPropagation();
      copyTask(task.id);
    }
  });
  copyBtn.appendChild(el('span', { text: '⧉' }));

  node.appendChild(el('div', { class: 'card__actions' }, [copyBtn, delBtn]));

  node.addEventListener('click', () => {
    editingTaskId = task.id;
    shouldAutofocus = true;
    render();
  });

  node.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      editingTaskId = task.id;
      shouldAutofocus = true;
      render();
    }
  });

  node.addEventListener('dragstart', (e) => {
    e.dataTransfer?.setData('text/task-id', task.id);
    e.dataTransfer?.setDragImage(node, 10, 10);
    document.body.classList.add('is-dragging');
    node.classList.add('is-dragging');
  });

  node.addEventListener('dragend', () => {
    document.body.classList.remove('is-dragging');
    node.classList.remove('is-dragging');
    for (const el of document.querySelectorAll('.column__list.is-drop-target')) el.classList.remove('is-drop-target');
  });

  return node;
}

function priorityTone(p) {
  if (p >= 8) return 'is-high';
  if (p >= 4) return 'is-med';
  if (p >= 1) return 'is-low';
  return 'is-none';
}

function openCreateModal(status) {
  if (!board) return;
  const initialStatus = board.columns.includes(status) ? status : board.columns[0];
  const tmp = {
    id: '__new__',
    title: '',
    goal: '',
    acceptanceCriteria: [''],
    notes: '',
    status: initialStatus,
    priority: 0,
    difficulty: 0,
    branchType: 'feature',
    order: 0,
    updatedAt: new Date().toISOString()
  };
  editingTaskId = tmp.id;
  shouldAutofocus = true;
  board = { ...board, tasks: [...board.tasks.filter((t) => t.id !== '__new__'), tmp] };
  render();
}

function taskModal(task) {
  const isNew = task.id === '__new__';

  const backdrop = el('div', { class: 'backdrop' });
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) closeModal();
  });

  const title = textField('Task title*', task.title, (v) => (task.title = v), {
    placeholder: 'Short, actionable title',
    autofocus: true
  });
  const goal = textArea('Goal', task.goal ?? '', (v) => (task.goal = v), { rows: 5, placeholder: 'What are we trying to achieve?' });
  const ac = textArea(
    'Acceptance criteria',
    (task.acceptanceCriteria ?? []).join('\n'),
    (v) => (task.acceptanceCriteria = v.split('\n').filter((s) => s.trim().length)),
    { rows: 6, placeholder: 'One item per line' }
  );
  const notes = textArea('Notes', task.notes ?? '', (v) => (task.notes = v), {
    rows: 7,
    grow: true,
    placeholder: 'Links, context, and notes (e.g. ADO#12345)'
  });

  const noteLinks = urlLinksFromNotes(task.notes ?? '');

  const ado = adoCommentSection(task);

  const status = dropdown('Status', board.columns, task.status, (v) => (task.status = v));
  const branch = dropdown('Branch type', ['feature', 'fix', 'chore'], task.branchType ?? 'feature', (v) => (task.branchType = v));
  const priority = numberField('Priority', String(task.priority ?? 0), (v) => (task.priority = clampInt(v, 0, 999)));
  const difficulty = stars('Difficulty', task.difficulty ?? 0, (v) => (task.difficulty = v));

  // Layout: task inputs on top (full width), settings compact below
  const taskPanel = el('div', { class: 'panel panel--task' }, [title, goal, ac, notes, noteLinks, ado]);
  // Order: Difficulty+Priority (same row) / Branch type+Status (same row)
  const settingsGrid = el('div', { class: 'settings-grid' }, [difficulty, priority, branch, status]);
  const settingsPanel = el('div', { class: 'panel panel--settings' }, [
    el('div', { class: 'panel__title', text: 'Settings' }),
    settingsGrid
  ]);

  const header = el('div', { class: 'modal__header' }, [
    el('div', { class: 'modal__title', text: isNew ? 'New task' : 'Edit task' }),
    el('vscode-button', { appearance: 'icon', onclick: closeModal, 'aria-label': 'close' }, [
      el('span', { text: '×' })
    ])
  ]);

  const body = el('div', { class: 'modal__body' }, [taskPanel, settingsPanel]);

  const footerLeft = el('div', { class: 'row' }, [
    isNew
      ? el('span')
      : el('vscode-button', { appearance: 'secondary', onclick: () => deleteTask(task.id), text: 'Delete' })
  ]);

  const footerRight = el('div', { class: 'row' }, [
    el('vscode-button', { appearance: 'secondary', onclick: closeModal, text: 'Cancel' }),
    el('vscode-button', { appearance: 'secondary', onclick: () => copyTask(task.id), text: 'Copy Markdown' }),
    el('vscode-button', { appearance: 'primary', onclick: () => saveTask(task), text: isNew ? 'Add' : 'Save' })
  ]);

  const footer = el('div', { class: 'modal__footer' }, [footerLeft, footerRight]);

  const modal = el(
    'div',
    { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': isNew ? 'New task' : 'Edit task' },
    [header, body, footer]
  );
  backdrop.appendChild(modal);
  return backdrop;
}

function extractAdoWorkItemId(task) {
  const text = String(task?.notes ?? '');
  const m = text.match(/\bADO#(\d+)\b/);
  if (!m) return null;
  const id = Number(m[1]);
  return Number.isFinite(id) && id > 0 ? id : null;
}

function adoCommentSection(task) {
  const id = extractAdoWorkItemId(task);
  if (!id) return el('div');

  const area = textArea('ADO comment', adoCommentDraft, (v) => (adoCommentDraft = v), {
    rows: 3,
    placeholder: 'Write a comment (paste an image to attach)'
  });
  const input = area.querySelector('vscode-text-area');
  if (input) {
    input.addEventListener('paste', async (e) => {
      const items = Array.from(e.clipboardData?.items ?? []);
      const img = items.find((it) => it.kind === 'file' && String(it.type).startsWith('image/'));
      if (!img) return;

      const file = img.getAsFile();
      if (!file) return;

      // Prevent default paste (image cannot be inserted into the text area anyway)
      e.preventDefault();

      // Guard: avoid sending huge payload over postMessage
      const maxBytes = 2 * 1024 * 1024; // 2MB
      if (file.size > maxBytes) {
        // Use file picker for large images
        return;
      }

      const base64 = await fileToBase64(file);
      vscode.postMessage({
        type: 'addAdoAttachment',
        workItemId: id,
        fileName: `pasted-${new Date().toISOString().replace(/[:.]/g, '-')}.png`,
        mime: file.type || 'image/png',
        dataBase64: base64,
        comment: String(adoCommentDraft ?? '').trim() || undefined
      });
    });
  }
  const post = el('vscode-button', {
    appearance: 'secondary',
    text: 'Post',
    title: `Post comment to ADO#${id}`,
    onclick: () => {
      const comment = String(adoCommentDraft ?? '').trim();
      if (!comment) return;
      vscode.postMessage({ type: 'addAdoComment', workItemId: id, comment });
      adoCommentDraft = '';
      render();
    }
  });

  const postWithAttach = el('vscode-button', {
    appearance: 'icon',
    title: 'Attach file…',
    'aria-label': 'Attach file',
    onclick: () => {
      const comment = String(adoCommentDraft ?? '').trim();
      vscode.postMessage({ type: 'addAdoCommentWithAttachment', workItemId: id, comment: comment || '' });
      render();
    }
  }, [el('span', { text: '+' })]);

  const updateDesc = el('vscode-button', {
    appearance: 'secondary',
    text: 'Update Description',
    title: `Update ADO#${id} Description from Goal/Acceptance Criteria`,
    onclick: () => {
      vscode.postMessage({
        type: 'syncAdoDescription',
        workItemId: id,
        goal: String(task.goal ?? ''),
        acceptanceCriteria: Array.isArray(task.acceptanceCriteria) ? task.acceptanceCriteria : []
      });
    }
  });

  return el('div', { class: 'field' }, [el('label', { text: 'Azure DevOps' }), area, el('div', { class: 'row' }, [post, postWithAttach, updateDesc])]);
}

async function fileToBase64(file) {
  const buf = await file.arrayBuffer();
  let binary = '';
  const bytes = new Uint8Array(buf);
  // Chunk to avoid call stack limits
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function urlLinksFromNotes(notesText) {
  const urls = Array.from(String(notesText).matchAll(/https?:\/\/\S+/g)).map((m) => m[0]);
  if (urls.length === 0) return el('div');

  const unique = Array.from(new Set(urls));
  const row = el('div', { class: 'row' });
  for (const url of unique) {
    const link = el('a', {
      href: '#',
      text: url,
      title: url,
      onclick: (e) => {
        e.preventDefault();
        vscode.postMessage({ type: 'openUrl', url });
      }
    });
    row.appendChild(link);
  }
  return el('div', { class: 'field' }, [el('label', { text: 'Links' }), row]);
}

function textField(label, value, onInput, opts = {}) {
  const field = el('div', { class: 'field' });
  field.appendChild(el('label', { text: label }));
  const input = el('vscode-text-field', opts.placeholder ? { placeholder: opts.placeholder } : {});
  if (opts.autofocus) input.setAttribute('data-autofocus', 'true');
  input.value = value;
  input.addEventListener('input', () => onInput(input.value));
  field.appendChild(input);
  return field;
}

function textArea(label, value, onInput, opts = {}) {
  const classes = ['field', 'field--textarea'];
  if (opts.grow) classes.push('field--grow');
  const field = el('div', { class: classes.join(' ') });
  field.appendChild(el('label', { text: label }));
  const input = el('vscode-text-area', opts.placeholder ? { placeholder: opts.placeholder } : {});
  input.value = value;
  input.rows = opts.rows ?? 4;
  input.addEventListener('input', () => onInput(input.value));
  field.appendChild(input);
  return field;
}

function dropdown(label, options, value, onChange) {
  const field = el('div', { class: 'field' });
  field.appendChild(el('label', { text: label }));
  const dd = el('vscode-dropdown');
  for (const opt of options) {
    const o = el('vscode-option', { value: opt, text: opt });
    dd.appendChild(o);
  }
  dd.value = value;
  dd.addEventListener('change', () => onChange(dd.value));
  field.appendChild(dd);
  return field;
}

function numberField(label, value, onInput) {
  const field = el('div', { class: 'field' });
  field.appendChild(el('label', { text: label }));
  const input = el('vscode-text-field');
  input.value = value;
  input.type = 'number';
  input.addEventListener('input', () => onInput(input.value));
  field.appendChild(input);
  return field;
}

function stars(label, value, onChange) {
  const field = el('div', { class: 'field' });
  field.appendChild(el('label', { text: label }));
  const row = el('div', { class: 'stars' });
  const current = clampInt(String(value), 0, 5);
  for (let i = 1; i <= 5; i++) {
    const b = el('button', { class: 'star', type: 'button' });
    b.setAttribute('aria-pressed', String(i <= current));
    b.textContent = '★';
    b.addEventListener('click', () => {
      onChange(i);
      render();
    });
    row.appendChild(b);
  }
  field.appendChild(row);
  return field;
}

function closeModal() {
  if (!board) return;
  // Discard temporary new task
  board = { ...board, tasks: board.tasks.filter((t) => t.id !== '__new__') };
  editingTaskId = null;
  shouldAutofocus = false;
  render();
}

function saveTask(task) {
  if (!board) return;

  if (!task.title || !task.title.trim()) {
    vscode.postMessage({ type: 'toast', message: 'Task title is required' });
    return;
  }

  if (task.id === '__new__') {
    vscode.postMessage({
      type: 'addTask',
      task: {
        title: task.title,
        status: task.status,
        priority: task.priority ?? 0,
        difficulty: task.difficulty || undefined,
        branchType: task.branchType || undefined,
        goal: task.goal || undefined,
        acceptanceCriteria: task.acceptanceCriteria || undefined,
        notes: task.notes || undefined
      }
    });
  } else {
    vscode.postMessage({
      type: 'updateTask',
      id: task.id,
      patch: {
        title: task.title,
        status: task.status,
        priority: task.priority ?? 0,
        difficulty: task.difficulty || undefined,
        branchType: task.branchType || undefined,
        goal: task.goal || undefined,
        acceptanceCriteria: task.acceptanceCriteria || undefined,
        notes: task.notes || undefined
      }
    });
  }

  editingTaskId = null;
}

function deleteTask(id) {
  if (id === '__new__') {
    closeModal();
    return;
  }

  vscode.postMessage({ type: 'deleteTask', id });
  editingTaskId = null;
  render();
}

function taskToMarkdown(task) {
  const lines = [];
  const title = String(task?.title ?? '').trim() || 'Untitled';
  lines.push(`# ${title}`);
  lines.push('');
  lines.push(`- status: ${String(task?.status ?? '')}`);
  lines.push(`- priority: ${String(task?.priority ?? 0)}`);
  if (typeof task?.difficulty === 'number') lines.push(`- difficulty: ${task.difficulty}`);
  if (task?.branchType) lines.push(`- branchType: ${task.branchType}`);
  lines.push('');

  const goal = String(task?.goal ?? '').trim();
  if (goal) {
    lines.push('## Goal');
    lines.push(goal);
    lines.push('');
  }

  const acceptanceCriteria = Array.isArray(task?.acceptanceCriteria)
    ? task.acceptanceCriteria.map((s) => String(s ?? '').trim()).filter((s) => s.length > 0)
    : [];
  if (acceptanceCriteria.length > 0) {
    lines.push('## Acceptance Criteria');
    for (const c of acceptanceCriteria) lines.push(`- ${c}`);
    lines.push('');
  }

  const notes = String(task?.notes ?? '').trim();
  if (notes) {
    lines.push('## Notes');
    lines.push(notes);
    lines.push('');
  }

  return lines.join('\n').trimEnd() + '\n';
}

async function copyTextToClipboard(text) {
  const value = String(text ?? '');
  if (!value) return false;

  if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    await navigator.clipboard.writeText(value);
    return true;
  }

  const active = document.activeElement;
  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.top = '0';
  textarea.style.left = '0';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  const ok = typeof document.execCommand === 'function' ? document.execCommand('copy') : false;
  document.body.removeChild(textarea);
  try {
    if (active && typeof active.focus === 'function') active.focus();
  } catch {
    // noop
  }
  return Boolean(ok);
}

async function copyTask(id) {
  if (id === '__new__') return;
  const task = board?.tasks?.find((t) => t.id === id);
  const md = task ? taskToMarkdown(task) : '';

  try {
    if (md && (await copyTextToClipboard(md))) {
      vscode.postMessage({ type: 'notify', level: 'info', message: 'Copied task as Markdown' });
      return;
    }
  } catch {
    // Fall back to extension clipboard API
  }

  vscode.postMessage({ type: 'copyTaskMarkdown', id, markdown: md || undefined });
}

function clampInt(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

window.addEventListener('message', (event) => {
  const msg = event.data;
  if (msg?.type === 'board') {
    board = msg.board;
    // External edits win: always replace with file contents
    editingTaskId = null;
    render();
  }
  if (msg?.type === 'state' && msg.state?.kind === 'no-workspace') {
    board = null;
    const root = document.getElementById('app');
    root.textContent = '';
    root.appendChild(el('div', { class: 'empty', text: 'Please open a workspace folder' }));
  }
});

window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (e.isComposing) return;
  if (!document.querySelector('.backdrop')) return;
  e.preventDefault();
  closeModal();
});

vscode.postMessage({ type: 'ready' });
render();
